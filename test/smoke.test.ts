import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffold", () => {
  it("knows its version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
