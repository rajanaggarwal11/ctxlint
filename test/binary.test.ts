import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * npm installs a bin as a symlink. A main-module guard that compares paths
 * without resolving them makes the CLI a no-op when run that way, which is
 * exactly how `npx ctxlint` runs it. So the built binary is executed through
 * a symlink here. Needs `pnpm build` first (the check script does that).
 */
const dist = resolve("dist/cli.js");
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ctxlint-bin-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!existsSync(dist))("the built binary", () => {
  it("does something when executed through a symlink", () => {
    const link = join(tmp, "ctxlint");
    symlinkSync(dist, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    expect(help).toContain("Exit codes");
  });
});
