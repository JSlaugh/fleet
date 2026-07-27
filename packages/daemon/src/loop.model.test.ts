import { describe, expect, it } from "vitest";
import { selectModel } from "./loop.ts";

describe("selectModel", () => {
  const project = { model: "claude-sonnet-5", elevatedModel: "claude-opus-5", lightModel: "claude-haiku-4-5-20251001" };

  it("uses the project default when neither tier label is present", () => {
    expect(selectModel(project, { elevated: false, light: false })).toBe("claude-sonnet-5");
  });

  it("uses the elevated model when fleet:elevate is present", () => {
    expect(selectModel(project, { elevated: true, light: false })).toBe("claude-opus-5");
  });

  it("uses the light model when fleet:light is present", () => {
    expect(selectModel(project, { elevated: false, light: true })).toBe("claude-haiku-4-5-20251001");
  });

  it("elevate wins when both labels are present", () => {
    expect(selectModel(project, { elevated: true, light: true })).toBe("claude-opus-5");
  });

  it("falls through to the project default when elevatedModel isn't configured", () => {
    expect(selectModel({ model: "claude-sonnet-5" }, { elevated: true, light: false })).toBe("claude-sonnet-5");
  });

  it("falls through to the project default when lightModel isn't configured", () => {
    expect(selectModel({ model: "claude-sonnet-5" }, { elevated: false, light: true })).toBe("claude-sonnet-5");
  });
});
