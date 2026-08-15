import { describe, expect, it } from "vitest";
import { looksDoubleEscaped } from "./worker.ts";

describe("looksDoubleEscaped", () => {
  it("is true for a double-escaped string (literal \\n, no real newline)", () => {
    expect(looksDoubleEscaped("line1\\nline2")).toBe(true);
  });

  it("is false when the string contains a real newline, even alongside a literal \\n mention", () => {
    // A summary that quotes the sequence `\n` in prose but is genuinely
    // multi-line must be left untouched.
    expect(looksDoubleEscaped("Here is code:\nconst s = '\\n';")).toBe(false);
  });

  it("is false for a plain string with no escapes", () => {
    expect(looksDoubleEscaped("just a normal sentence")).toBe(false);
  });

  it("is false for a normal multi-line string", () => {
    expect(looksDoubleEscaped("first line\nsecond line")).toBe(false);
  });
});
