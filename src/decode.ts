import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

/** Decode a body for the record. The wire is never touched; this is a copy. */
export function decodeBody(buf: Buffer, contentEncoding: string | undefined): Buffer {
  const enc = (contentEncoding ?? "").trim().toLowerCase();
  try {
    switch (enc) {
      case "":
      case "identity":
        return buf;
      case "gzip":
      case "x-gzip":
        return gunzipSync(buf);
      case "br":
        return brotliDecompressSync(buf);
      case "deflate":
        return inflateSync(buf);
      case "zstd":
        return zstdDecompressSync(buf);
      default:
        return buf;
    }
  } catch {
    return buf;
  }
}
