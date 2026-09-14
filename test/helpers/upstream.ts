import http from "node:http";
import { gzipSync } from "node:zlib";

export interface Received {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface Upstream {
  url: string;
  received: Received[];
  /** Every response body exactly as this server wrote it, in order. */
  sent: Buffer[];
  close(): Promise<void>;
}

const sse = (events: { event?: string; data: unknown }[]) =>
  events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`)
    .join("");

/**
 * A stand-in for api.anthropic.com and api.openai.com that speaks all three
 * wire formats, streaming and not, and remembers what it received and sent.
 */
export function startUpstream(): Promise<Upstream> {
  const received: Received[] = [];
  const sent: Buffer[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      received.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      let json: Record<string, unknown>;
      try {
        json = body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      const stream = json.stream === true;

      const reply = (status: number, headers: Record<string, string>, payload: Buffer | string) => {
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        sent.push(buf);
        res.writeHead(status, headers);
        res.end(buf);
      };

      if (url.pathname === "/headers") {
        return reply(200, { "content-type": "application/json" }, JSON.stringify(req.headers));
      }
      if (url.pathname === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const line = Buffer.alloc(1024, "x");
        const parts: Buffer[] = [];
        let i = 0;
        const tick = () => {
          if (i++ >= 5 * 1024) {
            sent.push(Buffer.concat(parts));
            return res.end();
          }
          parts.push(line);
          if (!res.write(line)) res.once("drain", tick);
          else setImmediate(tick);
        };
        return tick();
      }
      if (url.pathname === "/v1/messages") {
        if (stream) {
          return reply(
            200,
            { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
            sse([
              {
                event: "message_start",
                data: {
                  type: "message_start",
                  message: {
                    id: "msg_1",
                    usage: {
                      input_tokens: 400,
                      cache_read_input_tokens: 800,
                      cache_creation_input_tokens: 0,
                      output_tokens: 1,
                    },
                  },
                },
              },
              {
                event: "content_block_start",
                data: {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
              },
              {
                event: "content_block_delta",
                data: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Checking " },
                },
              },
              {
                event: "content_block_delta",
                data: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "the weather." },
                },
              },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
              {
                event: "content_block_start",
                data: {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
                },
              },
              {
                event: "content_block_delta",
                data: {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "input_json_delta", partial_json: '{"city":"Delhi"}' },
                },
              },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
              {
                event: "message_delta",
                data: {
                  type: "message_delta",
                  delta: { stop_reason: "tool_use" },
                  usage: { output_tokens: 42 },
                },
              },
              { event: "message_stop", data: { type: "message_stop" } },
            ]),
          );
        }
        const message = {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: json.model,
          content: [
            { type: "text", text: "Hello." },
            { type: "tool_use", id: "tu_2", name: "get_weather", input: { city: "Delhi" } },
          ],
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1000,
            output_tokens: 17,
          },
        };
        const text = JSON.stringify(message);
        if (url.searchParams.get("gzip") === "1") {
          return reply(
            200,
            { "content-type": "application/json", "content-encoding": "gzip" },
            gzipSync(text),
          );
        }
        return reply(200, { "content-type": "application/json" }, text);
      }
      if (url.pathname === "/v1/chat/completions") {
        const includeUsage =
          (json.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
        if (stream) {
          const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
            data: {
              id: "c1",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta, finish_reason: null }],
              ...extra,
            },
          });
          const events: { data: Record<string, unknown> }[] = [
            chunk({ role: "assistant", content: "Sure" }),
            chunk({ content: ", checking." }),
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_", arguments: "" },
                },
              ],
            }),
            chunk({
              tool_calls: [{ index: 0, function: { name: "weather", arguments: '{"city":' } }],
            }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '"Delhi"}' } }] }),
          ];
          if (includeUsage)
            events.push({
              data: {
                id: "c1",
                object: "chat.completion.chunk",
                choices: [],
                usage: {
                  prompt_tokens: 900,
                  completion_tokens: 30,
                  prompt_tokens_details: { cached_tokens: 512 },
                },
              },
            });
          return reply(
            200,
            { "content-type": "text/event-stream" },
            sse(events) + "data: [DONE]\n\n",
          );
        }
        return reply(
          200,
          { "content-type": "application/json" },
          JSON.stringify({
            id: "c2",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Hi.",
                  tool_calls: [
                    {
                      id: "call_2",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"Delhi"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 700,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
      }
      if (url.pathname === "/v1/responses") {
        const response = {
          id: "resp_1",
          object: "response",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Looking it up." }],
            },
            {
              type: "function_call",
              name: "get_weather",
              arguments: '{"city":"Delhi"}',
              call_id: "fc_1",
            },
          ],
          usage: {
            input_tokens: 1500,
            output_tokens: 25,
            input_tokens_details: { cached_tokens: 1024 },
          },
        };
        if (stream) {
          return reply(
            200,
            { "content-type": "text/event-stream" },
            sse([
              {
                event: "response.created",
                data: { type: "response.created", response: { id: "resp_1" } },
              },
              {
                event: "response.output_text.delta",
                data: { type: "response.output_text.delta", delta: "Looking " },
              },
              {
                event: "response.output_text.delta",
                data: { type: "response.output_text.delta", delta: "it up." },
              },
              { event: "response.completed", data: { type: "response.completed", response } },
            ]),
          );
        }
        return reply(200, { "content-type": "application/json" }, JSON.stringify(response));
      }
      reply(404, { "content-type": "text/plain" }, `no route for ${req.method} ${req.url}\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        sent,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
