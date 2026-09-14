import type { Exchange, Usage } from "../../src/types.js";

/** Roughly N tokens of distinct prose, so estimates are meaningful. */
export const prose = (tokens: number, seed = "alpha"): string => {
  const words = [
    "system",
    "invoice",
    "ledger",
    "tenant",
    "policy",
    "schema",
    "window",
    "render",
    "cache",
    "route",
  ];
  const out: string[] = [];
  for (let i = 0; out.length < tokens; i++) out.push(`${seed}-${words[i % words.length]}${i}`);
  return out.join(" ");
};

export interface AnthropicTurn {
  system?: string | { text: string; cache?: boolean }[];
  tools?: { name: string; description?: string; cache?: boolean }[];
  messages: { role: "user" | "assistant"; content: unknown }[];
  /** Provider usage. Omit for "no usage". */
  usage?: Partial<Usage>;
  /** Tool names the model called in the response. */
  calls?: string[];
  model?: string;
}

export function anthropicExchange(t: AnthropicTurn, i = 0): Exchange {
  const usage: Usage = t.usage
    ? { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, source: "provider", ...t.usage }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "none" };
  const body: Record<string, unknown> = {
    model: t.model ?? "claude-sonnet-5",
    max_tokens: 1024,
    messages: t.messages,
  };
  if (typeof t.system === "string") body.system = t.system;
  else if (t.system)
    body.system = t.system.map((s) => ({
      type: "text",
      text: s.text,
      ...(s.cache ? { cache_control: { type: "ephemeral" } } : {}),
    }));
  if (t.tools)
    body.tools = t.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? `${tool.name} does something useful for the user.`,
      input_schema: {
        type: "object",
        properties: { q: { type: "string", description: "The query" } },
      },
      ...(tool.cache ? { cache_control: { type: "ephemeral" } } : {}),
    }));
  return {
    id: `x${i}`,
    at: new Date(1_800_000_000_000 + i * 1000).toISOString(),
    upstream: "anthropic",
    method: "POST",
    path: "/v1/messages",
    kind: "anthropic-messages",
    model: String(body.model),
    stream: false,
    request: { headers: {}, body, bytes: 0 },
    response: {
      status: 200,
      headers: {},
      body: {},
      bytes: 0,
      truncated: false,
      usage,
      toolCalls: (t.calls ?? []).map((name) => ({ name })),
      text: "",
    },
    durationMs: 1,
  };
}

/** A conversation of N turns where each turn appends a user and an assistant message. */
export function conversation(
  n: number,
  base: Omit<AnthropicTurn, "messages">,
  opts: { grow?: number; usageFor?: (i: number) => Partial<Usage> } = {},
): Exchange[] {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [];
  const out: Exchange[] = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "user", content: prose(opts.grow ?? 50, `u${i}`) });
    out.push(
      anthropicExchange(
        { ...base, messages: [...messages], usage: opts.usageFor ? opts.usageFor(i) : base.usage },
        i,
      ),
    );
    messages.push({ role: "assistant", content: prose(20, `a${i}`) });
  }
  return out;
}
