import type { ApiKind, ToolCall, Usage } from "./types.js";

/** Headers that are a credential, or that would let a session file act as one. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie|x-auth-token|x-access-token)$|token|secret|credential|password/i;

export function stripCredentials(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    out[name] = CREDENTIAL_HEADER.test(name) ? "[stripped]" : Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export function apiKindOf(path: string): ApiKind {
  const p = path.split("?")[0] ?? path;
  if (p.endsWith("/messages")) return "anthropic-messages";
  if (p.endsWith("/chat/completions")) return "openai-chat";
  if (p.endsWith("/responses")) return "openai-responses";
  return "other";
}

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "none" };

/** Split an SSE body into its parsed `data:` payloads. Non-JSON payloads are kept as strings. */
export function parseSse(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push(data);
    }
  }
  return events;
}

interface Extracted {
  usage: Usage;
  toolCalls: ToolCall[];
  text: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

function anthropicUsage(u: unknown): Usage | undefined {
  const o = obj(u);
  if (!("input_tokens" in o) && !("output_tokens" in o)) return undefined;
  return {
    input:
      num(o.input_tokens) + num(o.cache_read_input_tokens) + num(o.cache_creation_input_tokens),
    output: num(o.output_tokens),
    cacheRead: num(o.cache_read_input_tokens),
    cacheWrite: num(o.cache_creation_input_tokens),
    source: "provider",
  };
}

function openaiUsage(u: unknown): Usage | undefined {
  const o = obj(u);
  if (!("input_tokens" in o) && !("prompt_tokens" in o)) return undefined;
  const details = obj(o.input_tokens_details ?? o.prompt_tokens_details);
  return {
    input: num(o.input_tokens ?? o.prompt_tokens),
    output: num(o.output_tokens ?? o.completion_tokens),
    cacheRead: num(details.cached_tokens),
    cacheWrite: 0,
    source: "provider",
  };
}

/**
 * Pull usage, tool calls and output text out of a response — a whole JSON body
 * or the list of SSE events — for each of the three wire formats.
 */
export function extract(kind: ApiKind, body: unknown, stream: boolean): Extracted {
  const events = stream && Array.isArray(body) ? body : [body];
  let usage: Usage | undefined;
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];
  // A Responses stream carries the text twice: as deltas, then whole in
  // response.completed. Deltas win when there were any.
  const responsesDeltas: string[] = [];
  // OpenAI chat streams split one tool call's name and arguments over many chunks.
  const chatCalls = new Map<number, { name: string; args: string }>();

  for (const ev of events) {
    const e = obj(ev);
    if (kind === "anthropic-messages") {
      if (e.type === "message_start") {
        usage = anthropicUsage(obj(e.message).usage) ?? usage;
      } else if (e.type === "message_delta") {
        const d = anthropicUsage(e.usage);
        if (d && usage) usage = { ...usage, output: d.output || usage.output };
        else if (d) usage = d;
      } else if (e.type === "content_block_start") {
        const b = obj(e.content_block);
        if (b.type === "tool_use" && typeof b.name === "string") toolCalls.push({ name: b.name });
      } else if (e.type === "content_block_delta") {
        const d = obj(e.delta);
        if (d.type === "text_delta" && typeof d.text === "string") textParts.push(d.text);
      } else if (Array.isArray(e.content)) {
        // A whole (non-stream) message.
        usage = anthropicUsage(e.usage) ?? usage;
        for (const c of e.content) {
          const b = obj(c);
          if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
          if (b.type === "tool_use" && typeof b.name === "string")
            toolCalls.push({ name: b.name, input: b.input });
        }
      }
    } else if (kind === "openai-chat") {
      usage = openaiUsage(e.usage) ?? usage;
      for (const ch of Array.isArray(e.choices) ? e.choices : []) {
        const c = obj(ch);
        const msg = obj(c.message);
        const delta = obj(c.delta);
        if (typeof msg.content === "string") textParts.push(msg.content);
        if (typeof delta.content === "string") textParts.push(delta.content);
        for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
          const f = obj(obj(tc).function);
          if (typeof f.name === "string") {
            let input: unknown;
            try {
              input = typeof f.arguments === "string" ? JSON.parse(f.arguments) : f.arguments;
            } catch {
              input = f.arguments;
            }
            toolCalls.push({ name: f.name, input });
          }
        }
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const t = obj(tc);
          const f = obj(t.function);
          const idx = num(t.index);
          const cur = chatCalls.get(idx) ?? { name: "", args: "" };
          if (typeof f.name === "string") cur.name += f.name;
          if (typeof f.arguments === "string") cur.args += f.arguments;
          chatCalls.set(idx, cur);
        }
      }
    } else if (kind === "openai-responses") {
      const resp =
        e.type === "response.completed" ? obj(e.response) : "output" in e ? e : undefined;
      if (resp) {
        usage = openaiUsage(resp.usage) ?? usage;
        for (const item of Array.isArray(resp.output) ? resp.output : []) {
          const it = obj(item);
          if (it.type === "function_call" && typeof it.name === "string") {
            let input: unknown;
            try {
              input = typeof it.arguments === "string" ? JSON.parse(it.arguments) : it.arguments;
            } catch {
              input = it.arguments;
            }
            toolCalls.push({ name: it.name, input });
          }
          if (it.type === "message") {
            for (const part of Array.isArray(it.content) ? it.content : []) {
              const p = obj(part);
              if (p.type === "output_text" && typeof p.text === "string") textParts.push(p.text);
            }
          }
        }
      } else if (e.type === "response.output_text.delta" && typeof e.delta === "string") {
        responsesDeltas.push(e.delta);
      }
    }
  }
  for (const [, c] of [...chatCalls.entries()].sort((a, b) => a[0] - b[0])) {
    let input: unknown;
    try {
      input = c.args ? JSON.parse(c.args) : undefined;
    } catch {
      input = c.args;
    }
    toolCalls.push({ name: c.name, input });
  }
  const text = responsesDeltas.length ? responsesDeltas.join("") : textParts.join("");
  return { usage: usage ?? NO_USAGE, toolCalls, text };
}
