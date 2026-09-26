import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfigFile, readProjectsConfig } from "./config-file.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "fleet-mcp-config-"));
}

describe("findConfigFile", () => {
  it("walks upward from the start directory", () => {
    const root = tempRoot();
    writeFileSync(join(root, "fleet.config.json"), "{}");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(join(root, "fleet.config.json"));
  });

  it("returns undefined when nothing is found", () => {
    expect(findConfigFile(tempRoot())).toBeUndefined();
  });

  it("uses an explicit path when given, and undefined if that path is missing", () => {
    const root = tempRoot();
    const explicit = join(root, "custom.json");
    writeFileSync(explicit, "{}");
    expect(findConfigFile(root, explicit)).toBe(explicit);
    expect(findConfigFile(root, join(root, "nope.json"))).toBeUndefined();
  });
});

describe("readProjectsConfig", () => {
  it("accepts a minimal projects-only config and ignores daemon-only fields", () => {
    const root = tempRoot();
    const path = join(root, "fleet.config.json");
    writeFileSync(path, `﻿${JSON.stringify({ pollIntervalSeconds: "not a number", projects: [{ name: "x", githubRepo: "o/r", repoPath: 42 }] })}`);
    expect(readProjectsConfig(path)).toEqual({ agents: ["claude"], projects: [{ name: "x", githubRepo: "o/r" }] });
  });

  it("rejects a config with no usable projects", () => {
    const root = tempRoot();
    const path = join(root, "fleet.config.json");
    writeFileSync(path, JSON.stringify({ projects: [{ name: "x", githubRepo: "not-a-repo" }] }));
    expect(() => readProjectsConfig(path)).toThrow(/owner\/repo/);
  });
});
