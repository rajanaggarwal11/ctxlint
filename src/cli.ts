#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  process.stdout.write("ctxlint — what are you actually sending the model?\n");
  return 0;
}

/** npm installs the bin as a symlink, so both sides are resolved before comparing. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
