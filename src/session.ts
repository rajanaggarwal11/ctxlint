import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Exchange } from "./types.js";

export const DEFAULT_SESSION = "ctxlint.session.jsonl";

/** One exchange per line. Credentials were stripped before the exchange existed. */
export function appendExchange(path: string, exchange: Exchange): void {
  appendFileSync(path, `${JSON.stringify(exchange)}\n`);
}

export function readSession(path: string): Exchange[] {
  if (!existsSync(path)) throw new Error(`no session file at ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as Exchange;
    } catch {
      throw new Error(`${path}:${i + 1} is not a ctxlint exchange`);
    }
  });
}
