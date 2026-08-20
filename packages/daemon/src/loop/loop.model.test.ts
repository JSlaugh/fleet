import { describe, expect, it } from "vitest";
import { selectEffort, selectModel } from "./runner.ts";

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

  it("uses the elevated model when the type's tier is elevated and no label is present", () => {
    expect(selectModel(project, { elevated: false, light: false, typeTier: "elevated" })).toBe("claude-opus-5");
  });

  it("uses the light model when the type's tier is light and no label is present", () => {
    expect(selectModel(project, { elevated: false, light: false, typeTier: "light" })).toBe("claude-haiku-4-5-20251001");
  });

  it("a tier of \"default\" behaves like no tier at all", () => {
    expect(selectModel(project, { elevated: false, light: false, typeTier: "default" })).toBe("claude-sonnet-5");
  });

  it("an explicit fleet:light label overrides a type tier of elevated", () => {
    expect(selectModel(project, { elevated: false, light: true, typeTier: "elevated" })).toBe("claude-haiku-4-5-20251001");
  });

  it("an explicit fleet:elevate label overrides a type tier of light", () => {
    expect(selectModel(project, { elevated: true, light: false, typeTier: "light" })).toBe("claude-opus-5");
  });

  it("the type tier falls through to the project default when its matching tier model isn't configured", () => {
    expect(selectModel({ model: "claude-sonnet-5" }, { elevated: false, light: false, typeTier: "elevated" })).toBe("claude-sonnet-5");
    expect(selectModel({ model: "claude-sonnet-5" }, { elevated: false, light: false, typeTier: "light" })).toBe("claude-sonnet-5");
  });
});

describe("selectEffort", () => {
  const project = { effort: "high" as const, elevatedEffort: "max" as const, lightEffort: "low" as const };

  it("uses the project default when neither tier label is present", () => {
    expect(selectEffort(project, { elevated: false, light: false })).toBe("high");
  });

  it("uses the elevated effort when fleet:elevate is present", () => {
    expect(selectEffort(project, { elevated: true, light: false })).toBe("max");
  });

  it("uses the light effort when fleet:light is present", () => {
    expect(selectEffort(project, { elevated: false, light: true })).toBe("low");
  });

  it("elevate wins when both labels are present", () => {
    expect(selectEffort(project, { elevated: true, light: true })).toBe("max");
  });

  it("falls through to the project default when elevatedEffort isn't configured", () => {
    expect(selectEffort({ effort: "high" }, { elevated: true, light: false })).toBe("high");
  });

  it("falls through to the project default when lightEffort isn't configured", () => {
    expect(selectEffort({ effort: "high" }, { elevated: false, light: true })).toBe("high");
  });

  it("is undefined when nothing is configured — no override, SDK default applies", () => {
    expect(selectEffort({}, { elevated: false, light: false })).toBeUndefined();
    expect(selectEffort({}, { elevated: true, light: false })).toBeUndefined();
    expect(selectEffort({}, { elevated: false, light: true })).toBeUndefined();
  });
});
