import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens.js";
import type { ApiKind, Exchange, Usage } from "./types.js";

export type SectionKind = "system" | "tool-def" | "user" | "assistant" | "tool-result";

export interface Section {
  kind: SectionKind;
  /** Position in the request, in the order the model reads it. */
  index: number;
  /** Message index for conversation sections; -1 for the system prompt and tool definitions. */
  turn: number;
  /** Tool name, for tool definitions, tool calls and tool results. */
  name?: string;
  text: string;
  /** Calibrated estimate (see `Context.exact`). */
  tokens: number;
  /** SHA-256 of the text, for duplicate and prefix comparison. */
  hash: string;
  /** The block carries an Anthropic `cache_control` marker. */
  cacheControl?: boolean;
}

export interface Context {
  kind: ApiKind;
  model?: string;
  sections: Section[];
  /** Names of every tool defined on the request, in order. */
  tools: string[];
  /** Names of tools the model called in the response. */
  toolCalls: string[];
  /** Sum of section tokens after calibration — the provider's input total when it was given. */
  totalTokens: number;
  /** True when totalTokens came from the provider; false when it is a tokenizer estimate. */
  exact: boolean;
  usage: Usage;
  /** Whether any section carries cache_control (Anthropic). */
  cached: boolean;
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text of a content field: a string, or an array of blocks whose text we can read. */
function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((b) => {
      const o = obj(b);
      switch (o.type) {
        case "text":
        case "input_text":
        case "output_text":
          return str(o.text);
        case "image":
        case "image_url":
        case "input_image":
          return "[image]";
        case "document":
        case "input_file":
          return "[document]";
        case "tool_result":
          return blocksText(o.content);
        default:
          return typeof o.text === "string" ? o.text : JSON.stringify(b);
      }
    })
    .join("\n");
}

interface Draft {
  kind: SectionKind;
  turn: number;
  name?: string;
  text: string;
  cacheControl?: boolean;
}

function anthropic(body: Record<string, unknown>): { drafts: Draft[]; tools: string[] } {
  const drafts: Draft[] = [];
  const tools: string[] = [];
  const system = body.system;
  if (typeof system === "string") drafts.push({ kind: "system", turn: -1, text: system });
  else if (Array.isArray(system)) {
    for (const b of system) {
      const o = obj(b);
      drafts.push({
        kind: "system",
        turn: -1,
        text: blocksText([b]),
        ...(o.cache_control ? { cacheControl: true } : {}),
      });
    }
  }
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const o = obj(t);
    const name = str(o.name);
    tools.push(name);
    drafts.push({
      kind: "tool-def",
      turn: -1,
      name,
      text: JSON.stringify({ name, description: o.description, input_schema: o.input_schema }),
      ...(o.cache_control ? { cacheControl: true } : {}),
    });
  }
  const callNames = new Map<string, string>();
  (Array.isArray(body.messages) ? body.messages : []).forEach((m, turn) => {
    const msg = obj(m);
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      drafts.push({ kind: role, turn, text: msg.content });
      return;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      const o = obj(b);
      const cc = o.cache_control ? { cacheControl: true } : {};
      if (o.type === "tool_use") {
        const name = str(o.name);
        if (typeof o.id === "string") callNames.set(o.id, name);
        drafts.push({
          kind: "assistant",
          turn,
          name,
          text: JSON.stringify({ name, input: o.input }),
          ...cc,
        });
      } else if (o.type === "tool_result") {
        const id = str(o.tool_use_id);
        drafts.push({
          kind: "tool-result",
          turn,
          name: callNames.get(id) ?? id,
          text: blocksText(o.content),
          ...cc,
        });
      } else {
        drafts.push({ kind: role, turn, text: blocksText([b]), ...cc });
      }
    }
  });
  return { drafts, tools };
}

function openaiChat(body: Record<string, unknown>): { drafts: Draft[]; tools: string[] } {
  const drafts: Draft[] = [];
  const tools: string[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const f = obj(obj(t).function);
    const name = str(f.name);
    tools.push(name);
    drafts.push({
      kind: "tool-def",
      turn: -1,
      name,
      text: JSON.stringify({ name, description: f.description, parameters: f.parameters }),
    });
  }
  for (const f of Array.isArray(body.functions) ? body.functions : []) {
    const o = obj(f);
    const name = str(o.name);
    tools.push(name);
    drafts.push({ kind: "tool-def", turn: -1, name, text: JSON.stringify(o) });
  }
  const callNames = new Map<string, string>();
  (Array.isArray(body.messages) ? body.messages : []).forEach((m, turn) => {
    const msg = obj(m);
    const role = str(msg.role);
    if (role === "system" || role === "developer") {
      drafts.push({ kind: "system", turn: -1, text: blocksText(msg.content) });
    } else if (role === "tool") {
      const id = str(msg.tool_call_id);
      drafts.push({
        kind: "tool-result",
        turn,
        name: callNames.get(id) ?? id,
        text: blocksText(msg.content),
      });
    } else if (role === "assistant") {
      if (msg.content !== null && msg.content !== undefined)
        drafts.push({ kind: "assistant", turn, text: blocksText(msg.content) });
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const c = obj(tc);
        const f = obj(c.function);
        const name = str(f.name);
        if (typeof c.id === "string") callNames.set(c.id, name);
        drafts.push({
          kind: "assistant",
          turn,
          name,
          text: JSON.stringify({ name, arguments: f.arguments }),
        });
      }
    } else {
      drafts.push({ kind: "user", turn, text: blocksText(msg.content) });
    }
  });
  return { drafts, tools };
}

function openaiResponses(body: Record<string, unknown>): { drafts: Draft[]; tools: string[] } {
  const drafts: Draft[] = [];
  const tools: string[] = [];
  if (typeof body.instructions === "string")
    drafts.push({ kind: "system", turn: -1, text: body.instructions });
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const o = obj(t);
    const name = str(o.name) || str(o.type);
    tools.push(name);
    drafts.push({ kind: "tool-def", turn: -1, name, text: JSON.stringify(o) });
  }
  const input = body.input;
  if (typeof input === "string") {
    drafts.push({ kind: "user", turn: 0, text: input });
    return { drafts, tools };
  }
  const callNames = new Map<string, string>();
  (Array.isArray(input) ? input : []).forEach((item, turn) => {
    const it = obj(item);
    const type = str(it.type) || "message";
    if (type === "message") {
      const role = str(it.role);
      if (role === "system" || role === "developer")
        drafts.push({ kind: "system", turn: -1, text: blocksText(it.content) });
      else
        drafts.push({
          kind: role === "assistant" ? "assistant" : "user",
          turn,
          text: blocksText(it.content),
        });
    } else if (type === "function_call") {
      const name = str(it.name);
      if (typeof it.call_id === "string") callNames.set(it.call_id, name);
      drafts.push({
        kind: "assistant",
        turn,
        name,
        text: JSON.stringify({ name, arguments: it.arguments }),
      });
    } else if (type === "function_call_output") {
      const id = str(it.call_id);
      drafts.push({
        kind: "tool-result",
        turn,
        name: callNames.get(id) ?? id,
        text: blocksText(it.output),
      });
    } else {
      drafts.push({ kind: "user", turn, text: JSON.stringify(item) });
    }
  });
  return { drafts, tools };
}

/**
 * The request as the model reads it: one ordered list of sections with
 * calibrated token counts. Returns undefined for a request that is not one of
 * the three chat formats (count_tokens, models, embeddings, …).
 */
export function contextOf(exchange: Exchange): Context | undefined {
  if (exchange.kind === "other") return undefined;
  const body = obj(exchange.request.body);
  if (!Object.keys(body).length) return undefined;
  const { drafts, tools } =
    exchange.kind === "anthropic-messages"
      ? anthropic(body)
      : exchange.kind === "openai-chat"
        ? openaiChat(body)
        : openaiResponses(body);

  const estimates = drafts.map((d) => estimateTokens(d.text));
  const estimated = estimates.reduce((a, b) => a + b, 0);
  const usage = exchange.response.usage;
  const exact = usage.source === "provider" && usage.input > 0;
  const factor = exact && estimated > 0 ? usage.input / estimated : 1;

  const sections: Section[] = drafts.map((d, index) => ({
    kind: d.kind,
    index,
    turn: d.turn,
    ...(d.name !== undefined ? { name: d.name } : {}),
    text: d.text,
    tokens: Math.round((estimates[index] ?? 0) * factor),
    hash: hash(d.text),
    ...(d.cacheControl ? { cacheControl: true } : {}),
  }));

  const model = exchange.model ?? (typeof body.model === "string" ? body.model : undefined);
  return {
    kind: exchange.kind,
    ...(model ? { model } : {}),
    sections,
    tools,
    toolCalls: exchange.response.toolCalls.map((t) => t.name),
    totalTokens: exact ? usage.input : estimated,
    exact,
    usage,
    cached: sections.some((s) => s.cacheControl),
  };
}
