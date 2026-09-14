import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { decodeBody } from "./decode.js";
import { apiKindOf, extract, parseSse, stripCredentials } from "./exchange.js";
import type { Exchange } from "./types.js";

export const DEFAULT_UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/** Headers that belong to one hop and must not be forwarded. `host` is set to the upstream's. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface ProxyOptions {
  port?: number;
  host?: string;
  upstreams?: Record<string, string>;
  /** Called once per completed exchange, after the client has the whole response. */
  onExchange?: (exchange: Exchange) => void;
  /** Bodies larger than this are kept truncated in the record; the wire is unaffected. */
  maxRecordBytes?: number;
}

export interface RunningProxy {
  port: number;
  url: string;
  upstreams: Record<string, string>;
  /** Environment variables that point an SDK at this proxy. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/**
 * A byte-faithful proxy. The request goes upstream exactly as received (minus
 * hop-by-hop headers), the response comes back exactly as the upstream sent it —
 * still compressed, still chunked, still streaming. A copy of each body is
 * decoded on the side for the record. Nothing here can change what the model
 * sees or what the client receives.
 */
export function startProxy(options: ProxyOptions = {}): Promise<RunningProxy> {
  const upstreams = { ...DEFAULT_UPSTREAMS, ...(options.upstreams ?? {}) };
  const maxRecord = options.maxRecordBytes ?? 8 * 1024 * 1024;

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://ctxlint.invalid");
    const [name, ...rest] = url.pathname.split("/").filter(Boolean);
    const base = name ? upstreams[name] : undefined;
    if (!name || !base) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `ctxlint: no upstream named "${name ?? ""}". Known: ${Object.keys(upstreams).join(", ")}. ` +
          `Point your SDK at ${`http://127.0.0.1:${(server.address() as { port: number }).port}/<name>`}.\n`,
      );
      return;
    }
    const path = `/${rest.join("/")}${url.search}`;
    const target = new URL(path, base.endsWith("/") ? base : `${base}/`);

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    headers.host = target.host;

    const client = target.protocol === "https:" ? https : http;
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;

    const upstreamReq = client.request(target, { method: req.method, headers }, (upstreamRes) => {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k)) continue;
        resHeaders[k] = v;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);

      const resChunks: Buffer[] = [];
      let resBytes = 0;
      let truncated = false;
      upstreamRes.on("data", (chunk: Buffer) => {
        resBytes += chunk.length;
        if (resBytes <= maxRecord) resChunks.push(chunk);
        else truncated = true;
      });
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => {
        if (!options.onExchange) return;
        const reqBody = decodeBody(Buffer.concat(reqChunks), req.headers["content-encoding"]);
        const resBody = truncated
          ? Buffer.concat(resChunks)
          : decodeBody(Buffer.concat(resChunks), upstreamRes.headers["content-encoding"]);
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const stream = contentType.includes("text/event-stream");
        const kind = apiKindOf(path);
        const requestJson = parseJson(reqBody.toString("utf8"));
        const responseBody = truncated
          ? `[truncated: ${resBytes} bytes]`
          : stream
            ? parseSse(resBody.toString("utf8"))
            : parseJson(resBody.toString("utf8"));
        const { usage, toolCalls, text } = truncated
          ? { usage: extract(kind, undefined, false).usage, toolCalls: [], text: "" }
          : extract(kind, responseBody, stream);
        const model =
          requestJson && typeof requestJson === "object" && "model" in requestJson
            ? String((requestJson as { model: unknown }).model)
            : undefined;
        options.onExchange({
          id: randomUUID(),
          at: new Date(started).toISOString(),
          upstream: name,
          method: req.method ?? "GET",
          path,
          kind,
          ...(model ? { model } : {}),
          stream,
          request: { headers: stripCredentials(req.headers), body: requestJson, bytes: reqBytes },
          response: {
            status: upstreamRes.statusCode ?? 0,
            headers: stripCredentials(upstreamRes.headers),
            body: responseBody,
            bytes: resBytes,
            truncated,
            usage,
            toolCalls,
            text,
          },
          durationMs: Date.now() - started,
        });
      });
    });

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`ctxlint: upstream "${name}" (${target.origin}) is unreachable: ${err.message}\n`);
      options.onExchange?.({
        id: randomUUID(),
        at: new Date(started).toISOString(),
        upstream: name,
        method: req.method ?? "GET",
        path,
        kind: apiKindOf(path),
        stream: false,
        request: {
          headers: stripCredentials(req.headers),
          body: parseJson(Buffer.concat(reqChunks).toString("utf8")),
          bytes: reqBytes,
        },
        response: {
          status: 502,
          headers: {},
          body: undefined,
          bytes: 0,
          truncated: false,
          usage: extract("other", undefined, false).usage,
          toolCalls: [],
          text: "",
        },
        durationMs: Date.now() - started,
        error: err.message,
      });
    });

    req.on("data", (chunk: Buffer) => {
      reqBytes += chunk.length;
      if (reqBytes <= maxRecord) reqChunks.push(chunk);
    });
    req.pipe(upstreamReq);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        port,
        url,
        upstreams,
        env: { ANTHROPIC_BASE_URL: `${url}/anthropic`, OPENAI_BASE_URL: `${url}/openai/v1` },
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
