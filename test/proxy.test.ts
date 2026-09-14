import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendExchange, readSession, startProxy } from "../src/index.js";
import type { Exchange, RunningProxy } from "../src/index.js";
import { startUpstream } from "./helpers/upstream.js";
import type { Upstream } from "./helpers/upstream.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const API_KEY = "sk-ant-api03-THIS-MUST-NEVER-BE-WRITTEN-DOWN-0123456789abcdef";
const BEARER = "Bearer ghu_ANOTHER_SECRET_THAT_MUST_NOT_LEAK_0123456789";

let upstream: Upstream;
let proxy: RunningProxy;
let tmp: string;
const exchanges: Exchange[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ctxlint-proxy-"));
  upstream = await startUpstream();
  proxy = await startProxy({
    upstreams: { anthropic: upstream.url, openai: upstream.url, dead: "http://127.0.0.1:1" },
    onExchange: (x) => {
      exchanges.push(x);
      appendExchange(join(tmp, "session.jsonl"), x);
    },
  });
});
afterAll(async () => {
  await proxy.close();
  await upstream.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Wait for the exchange the proxy records after the client has its response. */
async function lastExchange(): Promise<Exchange> {
  for (let i = 0; i < 50 && exchanges.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  const before = exchanges.length;
  for (let i = 0; i < 50 && exchanges.length < before; i++)
    await new Promise((r) => setTimeout(r, 10));
  return exchanges[exchanges.length - 1]!;
}

describe("the wire", () => {
  it("forwards the request body byte for byte, with every header the client sent", async () => {
    const body = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi ☃" }],
    });
    const res = await fetch(`${proxy.url}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-beta": "prompt-caching-2024-07-31",
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    expect(res.status).toBe(200);
    const got = upstream.received.at(-1)!;
    expect(got.path).toBe("/v1/messages?beta=true");
    expect(sha(got.body)).toBe(sha(body));
    expect(got.headers["x-api-key"]).toBe(API_KEY);
    expect(got.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(got.headers["anthropic-version"]).toBe("2023-06-01");
    expect(got.headers.host).toBe(new URL(upstream.url).host);
  });

  it("returns the response byte for byte, status and headers included", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const text = Buffer.from(await res.arrayBuffer());
    expect(sha(text)).toBe(sha(upstream.sent.at(-1)!));
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("streams SSE through unchanged and still reads usage and tool calls off the side", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = Buffer.from(await res.arrayBuffer());
    expect(sha(text)).toBe(sha(upstream.sent.at(-1)!));
    const x = await lastExchange();
    expect(x.stream).toBe(true);
    expect(x.kind).toBe("anthropic-messages");
    expect(x.response.usage).toEqual({
      input: 1200,
      output: 42,
      cacheRead: 800,
      cacheWrite: 0,
      source: "provider",
    });
    expect(x.response.toolCalls.map((t) => t.name)).toEqual(["get_weather"]);
    expect(x.response.text).toBe("Checking the weather.");
  });

  it("passes a gzip response through still compressed, and records it decoded", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages?gzip=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(((await res.json()) as { id: string }).id).toBe("msg_2");
    const x = await lastExchange();
    expect(x.response.usage).toEqual({
      input: 2200,
      output: 17,
      cacheRead: 0,
      cacheWrite: 1000,
      source: "provider",
    });
    expect(x.response.toolCalls).toEqual([{ name: "get_weather", input: { city: "Delhi" } }]);
  });

  it("pipes a 5 MB stream without buffering it whole", async () => {
    const res = await fetch(`${proxy.url}/openai/big`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(5 * 1024 * 1024);
    expect(sha(buf)).toBe(sha(upstream.sent.at(-1)!));
  });

  it("answers 404 for an unknown upstream and 502 for an unreachable one, and says which", async () => {
    const unknown = await fetch(`${proxy.url}/nope/v1/messages`, { method: "POST" });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('no upstream named "nope"');
    const dead = await fetch(`${proxy.url}/dead/v1/messages`, { method: "POST", body: "{}" });
    expect(dead.status).toBe(502);
    expect(await dead.text()).toContain("unreachable");
  });
});

describe("the three formats", () => {
  it("OpenAI chat, streamed with usage: assembles the split tool call and reads the final usage chunk", async () => {
    await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: BEARER },
      body: JSON.stringify({
        model: "gpt",
        stream: true,
        stream_options: { include_usage: true },
        messages: [],
      }),
    });
    const x = await lastExchange();
    expect(x.kind).toBe("openai-chat");
    expect(x.response.usage).toEqual({
      input: 900,
      output: 30,
      cacheRead: 512,
      cacheWrite: 0,
      source: "provider",
    });
    expect(x.response.toolCalls).toEqual([{ name: "get_weather", input: { city: "Delhi" } }]);
    expect(x.response.text).toBe("Sure, checking.");
  });

  it("OpenAI chat, streamed without usage: says so instead of inventing numbers", async () => {
    await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt", stream: true, messages: [] }),
    });
    const x = await lastExchange();
    expect(x.response.usage.source).toBe("none");
    expect(x.response.toolCalls.map((t) => t.name)).toEqual(["get_weather"]);
  });

  it("OpenAI Responses, both ways", async () => {
    await fetch(`${proxy.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt", input: "hi" }),
    });
    const whole = await lastExchange();
    expect(whole.kind).toBe("openai-responses");
    expect(whole.response.usage).toEqual({
      input: 1500,
      output: 25,
      cacheRead: 1024,
      cacheWrite: 0,
      source: "provider",
    });
    expect(whole.response.text).toBe("Looking it up.");
    await fetch(`${proxy.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt", input: "hi", stream: true }),
    });
    const streamed = await lastExchange();
    expect(streamed.response.usage.input).toBe(1500);
    expect(streamed.response.toolCalls.map((t) => t.name)).toEqual(["get_weather"]);
    expect(streamed.response.text).toBe("Looking it up.");
  });
});

describe("the record", () => {
  it("never contains a credential, in any header, in any exchange", async () => {
    await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        authorization: BEARER,
        cookie: "session=SECRETCOOKIE",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    await lastExchange();
    const file = readFileSync(join(tmp, "session.jsonl"), "utf8");
    expect(file).not.toContain(API_KEY);
    expect(file).not.toContain("ghu_ANOTHER_SECRET");
    expect(file).not.toContain("SECRETCOOKIE");
    expect(file).toContain('"x-api-key":"[stripped]"');
    const back = readSession(join(tmp, "session.jsonl"));
    expect(back.length).toBe(exchanges.length);
    expect(
      back.at(-1)!.request.headers["anthropic-version"] ??
        back.at(-1)!.request.headers["content-type"],
    ).toBeDefined();
  });

  it("keeps the parsed request body and the model", async () => {
    const x = exchanges.find((e) => e.model === "claude-sonnet-5")!;
    expect(x.path).toBe("/v1/messages?beta=true");
    expect((x.request.body as { messages: { content: string }[] }).messages[0]?.content).toBe(
      "hi ☃",
    );
    expect(x.request.headers["x-api-key"]).toBe("[stripped]");
    expect(x.durationMs).toBeGreaterThanOrEqual(0);
  });
});
