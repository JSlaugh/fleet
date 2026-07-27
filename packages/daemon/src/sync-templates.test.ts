import { describe, expect, it } from "vitest";
import { mergeMcpConfig } from "./sync-templates.ts";

const FLEET_ENTRY = {
  command: "pnpm",
  args: ["--dir", "C:/Users/j/github/fleet", "--filter", "@fleet/mcp", "start"],
  env: { FLEET_PROJECT: "example", FLEET_URL: "http://localhost:4400" },
};

describe("mergeMcpConfig", () => {
  it("creates a fresh file with only the fleet entry when none exists", () => {
    const result = mergeMcpConfig(undefined, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({ mcpServers: { fleet: FLEET_ENTRY } });
  });

  it("replaces only the fleet entry, preserving other servers and top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: "node", args: ["other-server.js"] },
        fleet: { command: "stale", args: [] },
      },
      someOtherTopLevelKey: true,
    });
    const result = mergeMcpConfig(existing, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({
      mcpServers: {
        other: { command: "node", args: ["other-server.js"] },
        fleet: FLEET_ENTRY,
      },
      someOtherTopLevelKey: true,
    });
  });

  it("tolerates a UTF-8 BOM-prefixed existing file", () => {
    const bom = String.fromCharCode(0xfeff);
    const existing = `${bom}${JSON.stringify({ mcpServers: { other: { command: "node" } } })}`;
    const result = mergeMcpConfig(existing, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({
      mcpServers: { other: { command: "node" }, fleet: FLEET_ENTRY },
    });
  });

  it("throws a clear error on malformed existing JSON", () => {
    expect(() => mergeMcpConfig("{ not valid json", FLEET_ENTRY)).toThrow(/not valid JSON/);
  });

  it("adds an mcpServers object when the existing file lacks one", () => {
    const existing = JSON.stringify({ unrelated: "value" });
    const result = mergeMcpConfig(existing, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({ unrelated: "value", mcpServers: { fleet: FLEET_ENTRY } });
  });

  it("is idempotent: merging the same entry twice produces the same result", () => {
    const first = mergeMcpConfig(undefined, FLEET_ENTRY);
    const second = mergeMcpConfig(first, FLEET_ENTRY);
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });
});
