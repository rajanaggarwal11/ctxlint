/**
 * Text patterns shared by the security rules. The same families mcpcheck uses
 * for tool descriptions, applied here to what arrives in tool results and to
 * everything that reaches the model.
 */
export interface TextPattern {
  pattern: RegExp;
  why: string;
}

export const INSTRUCTION_PATTERNS: TextPattern[] = [
  {
    pattern:
      /\bignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|other|system)\s+(instructions?|prompts?|rules?|guidance|tools?)/i,
    why: "tells the model to ignore its instructions",
  },
  {
    pattern:
      /\b(do\s+not|don'?t|never)\s+(tell|inform|mention|reveal|show|warn|ask|notify)\b[^.]{0,60}\b(user|human|operator)\b/i,
    why: "asks the model to hide something from the user",
  },
  {
    pattern: /<\s*(system|assistant|instruction|hidden|im_start)\b[^>]*>|\[\s*(system|inst)\s*\]/i,
    why: "contains a fake role or instruction tag",
  },
  {
    pattern:
      /\b(you\s+must|you\s+should\s+always|always\s+(call|use|run|invoke|execute|send|include)|as\s+an?\s+ai\s+(assistant|model),?\s+you)\b/i,
    why: "contains an imperative directed at the model",
  },
  {
    pattern:
      /(?<!\b(?:not|never|don'?t|without|avoid|nor)\s+(?:\w+\s+){0,2})\b(send|forward|include|attach|pass|transmit|post|exfiltrate)\b[^.]{0,60}\b(api[\s_-]?keys?|tokens?|passwords?|secrets?|credentials?|\.env|ssh[\s_-]?keys?|private[\s_-]?keys?)\b/i,
    why: "asks for credentials to be sent along",
  },
];

// Built from code points on purpose: a raw U+2028 in source is a line
// terminator to the parser, and backslash-u escapes have been observed to
// arrive decoded.
const cp = (n: number): string => String.fromCodePoint(n);
const span = (from: number, to: number): string => `${cp(from)}-${cp(to)}`;
export const INVISIBLE = new RegExp(
  `[${span(0x200b, 0x200f)}${span(0x2028, 0x202e)}${span(0x2060, 0x2064)}${span(0x2066, 0x2069)}${cp(0xfeff)}]` +
    `|[${span(0xe0000, 0xe007f)}]`,
  "u",
);

export const SECRET_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { pattern: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/, what: "an sk- API key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, what: "a GitHub token" },
  { pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, what: "a Slack token" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/, what: "a bearer token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "a Google API key" },
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i,
    what: "a database URL with a password",
  },
];

export function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}
