import { describe, expect, it } from "vitest";
import { parseUrlState, serializeUrlState, type UrlState } from "./urlState.ts";

describe("serializeUrlState", () => {
  it("returns an empty string for the default state", () => {
    expect(serializeUrlState({ view: "board" })).toBe("");
  });

  it("emits only the params that differ from defaults", () => {
    expect(serializeUrlState({ view: "history" })).toBe("?view=history");
    expect(serializeUrlState({ view: "board", project: "fleet" })).toBe("?project=fleet");
  });

  it("serializes the selected ticket as project:issueNumber", () => {
    const query = serializeUrlState({ view: "board", ticket: { project: "fleet", issueNumber: 142 } });

    expect(query).toBe(`?ticket=${encodeURIComponent("fleet:142")}`);
  });
});

describe("parseUrlState", () => {
  it("round-trips a fully populated state", () => {
    const state: UrlState = { view: "history", project: "fleet", ticket: { project: "alpha", issueNumber: 62 } };

    expect(parseUrlState(serializeUrlState(state))).toEqual(state);
  });

  it("returns defaults for an empty search string", () => {
    expect(parseUrlState("")).toEqual({ view: "board", project: undefined, ticket: undefined });
  });

  it("falls back to board for an unknown view", () => {
    expect(parseUrlState("?view=settings").view).toBe("board");
  });

  it("ignores params it does not know", () => {
    expect(parseUrlState("?foo=bar&view=history")).toEqual({ view: "history", project: undefined, ticket: undefined });
  });

  it.each([
    { name: "no separator", raw: "142" },
    { name: "empty project", raw: ":142" },
    { name: "non-numeric issue", raw: "fleet:abc" },
    { name: "fractional issue", raw: "fleet:1.5" },
    { name: "zero issue", raw: "fleet:0" },
    { name: "negative issue", raw: "fleet:-3" },
  ])("drops a malformed ticket param ($name)", ({ raw }) => {
    expect(parseUrlState(`?ticket=${encodeURIComponent(raw)}`).ticket).toBeUndefined();
  });

  it("keeps a project name containing a colon by splitting on the last one", () => {
    expect(parseUrlState(`?ticket=${encodeURIComponent("org:repo:7")}`).ticket).toEqual({
      project: "org:repo",
      issueNumber: 7,
    });
  });
});
