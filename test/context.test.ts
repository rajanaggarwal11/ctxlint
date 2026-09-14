import { describe, expect, it } from "vitest";
import { contextOf } from "../src/context.js";
import type { Exchange, Usage } from "../src/types.js";

const provider = (input: number, cacheRead = 0): Usage => ({
  input,
  output: 5,
  cacheRead,
  cacheWrite: 0,
  source: "provider",
});
const none: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "none" };

function exchange(
  kind: Exchange["kind"],
  body: unknown,
  usage: Usage,
  toolCalls: string[] = [],
): Exchange {
  return {
    id: "x",
    at: "2026-09-14T00:00:00Z",
    upstream: "u",
    method: "POST",
    path: "/v1/x",
    kind,
    stream: false,
    request: { headers: {}, body, bytes: 0 },
    response: {
      status: 200,
      headers: {},
      body: {},
      bytes: 0,
      truncated: false,
      usage,
      toolCalls: toolCalls.map((name) => ({ name })),
      text: "",
    },
    durationMs: 1,
  };
}

const LONG = "The quick brown fox jumps over the lazy dog. ".repeat(40);

describe("Anthropic Messages", () => {
  const body = {
    model: "claude-sonnet-5",
    system: [
      { type: "text", text: "You are a careful assistant.", cache_control: { type: "ephemeral" } },
      { type: "text", text: LONG },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
      {
        name: "send_email",
        description: "Sends email",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "user", content: "What's the weather in Delhi?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Delhi" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [{ type: "text", text: "31°C, clear" }],
          },
          { type: "text", text: "Thanks — and tomorrow?" },
        ],
      },
    ],
  };

  it("lays the request out in reading order, names tool results after the call they answer, and keeps cache markers", () => {
    const ctx = contextOf(
      exchange("anthropic-messages", body, provider(2000, 1200), ["get_weather"]),
    )!;
    expect(ctx.sections.map((s) => s.kind)).toEqual([
      "system",
      "system",
      "tool-def",
      "tool-def",
      "user",
      "assistant",
      "assistant",
      "tool-result",
      "user",
    ]);
    expect(ctx.tools).toEqual(["get_weather", "send_email"]);
    expect(ctx.toolCalls).toEqual(["get_weather"]);
    expect(ctx.sections[0]?.cacheControl).toBe(true);
    expect(ctx.sections[3]?.cacheControl).toBe(true);
    expect(ctx.sections[1]?.cacheControl).toBeUndefined();
    expect(ctx.sections[6]).toMatchObject({ kind: "assistant", name: "get_weather", turn: 1 });
    expect(ctx.sections[7]).toMatchObject({
      kind: "tool-result",
      name: "get_weather",
      turn: 2,
      text: "31°C, clear",
    });
    expect(ctx.cached).toBe(true);
    expect(ctx.model).toBe("claude-sonnet-5");
  });

  it("calibrates section estimates so they sum to the provider's exact total", () => {
    const ctx = contextOf(exchange("anthropic-messages", body, provider(2000)))!;
    expect(ctx.exact).toBe(true);
    expect(ctx.totalTokens).toBe(2000);
    const sum = ctx.sections.reduce((a, s) => a + s.tokens, 0);
    expect(Math.abs(sum - 2000)).toBeLessThanOrEqual(ctx.sections.length); // rounding
    const long = ctx.sections[1]!;
    const short = ctx.sections[0]!;
    expect(long.tokens).toBeGreaterThan(short.tokens * 10);
  });

  it("falls back to the raw estimate, and says so, when the response carried no usage", () => {
    const ctx = contextOf(exchange("anthropic-messages", body, none))!;
    expect(ctx.exact).toBe(false);
    expect(ctx.totalTokens).toBeGreaterThan(300);
    expect(ctx.totalTokens).toBeLessThan(1000);
  });

  it("accepts a plain string system prompt", () => {
    const ctx = contextOf(
      exchange(
        "anthropic-messages",
        { model: "m", system: "Be brief.", messages: [{ role: "user", content: "hi" }] },
        none,
      ),
    )!;
    expect(ctx.sections.map((s) => [s.kind, s.text])).toEqual([
      ["system", "Be brief."],
      ["user", "hi"],
    ]);
  });
});

describe("OpenAI Chat Completions", () => {
  it("maps system/developer, tool definitions, tool_calls and tool messages", () => {
    const body = {
      model: "gpt",
      messages: [
        { role: "developer", content: "You are terse." },
        {
          role: "user",
          content: [
            { type: "text", text: "Weather in Delhi?" },
            { type: "image_url", image_url: { url: "data:..." } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Delhi"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "31°C" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Weather", parameters: { type: "object" } },
        },
      ],
    };
    const ctx = contextOf(exchange("openai-chat", body, provider(500)))!;
    expect(ctx.sections.map((s) => s.kind)).toEqual([
      "tool-def",
      "system",
      "user",
      "assistant",
      "tool-result",
    ]);
    expect(ctx.sections[2]?.text).toBe("Weather in Delhi?\n[image]");
    expect(ctx.sections[3]).toMatchObject({ name: "get_weather", turn: 2 });
    expect(ctx.sections[4]).toMatchObject({ name: "get_weather", text: "31°C", turn: 3 });
    expect(ctx.tools).toEqual(["get_weather"]);
    expect(ctx.totalTokens).toBe(500);
  });
});

describe("OpenAI Responses", () => {
  it("maps instructions, a string input, and tools", () => {
    const ctx = contextOf(
      exchange(
        "openai-responses",
        {
          model: "gpt",
          instructions: "Be kind.",
          input: "hello",
          tools: [{ type: "function", name: "get_weather", parameters: {} }],
        },
        provider(80),
      ),
    )!;
    expect(ctx.sections.map((s) => [s.kind, s.name ?? s.text])).toEqual([
      ["system", "Be kind."],
      ["tool-def", "get_weather"],
      ["user", "hello"],
    ]);
  });

  it("maps an item list with function calls and outputs", () => {
    const input = [
      { role: "user", content: [{ type: "input_text", text: "Weather?" }] },
      {
        type: "function_call",
        call_id: "fc_1",
        name: "get_weather",
        arguments: '{"city":"Delhi"}',
      },
      { type: "function_call_output", call_id: "fc_1", output: "31°C" },
      { role: "assistant", content: [{ type: "output_text", text: "31°C in Delhi." }] },
    ];
    const ctx = contextOf(exchange("openai-responses", { model: "gpt", input }, provider(120)))!;
    expect(ctx.sections.map((s) => s.kind)).toEqual([
      "user",
      "assistant",
      "tool-result",
      "assistant",
    ]);
    expect(ctx.sections[2]).toMatchObject({ name: "get_weather", text: "31°C" });
  });
});

describe("everything else", () => {
  it("is not a context", () => {
    expect(contextOf(exchange("other", { model: "m" }, none))).toBeUndefined();
    expect(contextOf(exchange("anthropic-messages", "not json", none))).toBeUndefined();
  });
});
