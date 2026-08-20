import { afterEach, describe, expect, it, vi } from "vitest";
import { suppressCanUseToolShadowedWarning } from "./log.ts";

const realEmitWarning = process.emitWarning;

afterEach(() => {
  process.emitWarning = realEmitWarning;
});

/** Installs the filter over a spy standing in for Node's real emitWarning. */
function install() {
  const underlying = vi.fn();
  process.emitWarning = underlying as unknown as typeof process.emitWarning;
  suppressCanUseToolShadowedWarning();
  return underlying;
}

describe("suppressCanUseToolShadowedWarning", () => {
  it("swallows the SDK warning via the options-object overload", () => {
    const underlying = install();

    process.emitWarning("canUseTool will not be invoked", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });

    expect(underlying).not.toHaveBeenCalled();
  });

  it("swallows it via the positional (type, code) overload", () => {
    const underlying = install();

    process.emitWarning("canUseTool will not be invoked", "Warning", "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED");

    expect(underlying).not.toHaveBeenCalled();
  });

  it("passes every other warning through with its arguments intact", () => {
    const underlying = install();

    process.emitWarning("something else", { code: "DEP0190" });

    expect(underlying).toHaveBeenCalledWith("something else", { code: "DEP0190" });
  });
});
