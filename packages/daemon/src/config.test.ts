import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";

const validConfig = {
  worktreeRoot: "/tmp/wt",
  projects: [
    { name: "alpha", repoPath: "/repo/alpha", githubRepo: "acme/alpha" },
  ],
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fleet-config-"));
}

describe("loadConfig with an explicit path", () => {
  it("reads and validates a config file, applying schema defaults", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(path, JSON.stringify(validConfig));

    const { config, configDir } = loadConfig(path);

    expect(configDir).toBe(dir);
    expect(config.worktreeRoot).toBe("/tmp/wt");
    expect(config.projects[0]?.defaultBranch).toBe("main");
    expect(config.pollIntervalSeconds).toBe(60);
  });

  it("strips a leading UTF-8 BOM before parsing", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(path, "﻿" + JSON.stringify(validConfig));

    const { config } = loadConfig(path);

    expect(config.worktreeRoot).toBe("/tmp/wt");
  });

  it("throws a readable error listing zod issues for an invalid config", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(path, JSON.stringify({ worktreeRoot: "/tmp/wt", projects: [] }));

    expect(() => loadConfig(path)).toThrow(/Invalid config at/);
    expect(() => loadConfig(path)).toThrow(/projects/);
  });

  it("throws when the file does not exist", () => {
    const path = join(tempDir(), "missing.config.json");
    expect(() => loadConfig(path)).toThrow(/Config not found/);
  });
});

describe("loadConfig warns on unknown keys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns on an unrecognized top-level key, naming its path", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(path, JSON.stringify({ ...validConfig, pollIntervalSeconnds: 30 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig(path);

    expect(logSpy.mock.calls.some(([line]) => String(line).includes("pollIntervalSeconnds"))).toBe(true);
  });

  it("warns on an unrecognized key inside a projects[] entry, naming its indexed path", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...validConfig,
        projects: [{ name: "alpha", repoPath: "/repo/alpha", githubRepo: "acme/alpha", machineRevieww: false }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig(path);

    expect(logSpy.mock.calls.some(([line]) => String(line).includes("projects[0].machineRevieww"))).toBe(true);
  });

  it("warns on an unrecognized key inside a nested object like notifications", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...validConfig,
        notifications: { discordUrl: "https://discord.com/api/webhooks/1/x", digestTimme: "09:00" },
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig(path);

    expect(logSpy.mock.calls.some(([line]) => String(line).includes("notifications.digestTimme"))).toBe(true);
  });

  it("logs no warnings for a clean config", () => {
    const dir = tempDir();
    const path = join(dir, "fleet.config.json");
    writeFileSync(path, JSON.stringify(validConfig));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig(path);

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("loadConfig's upward search for a default config", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("walks up from cwd until it finds fleet.config.json", () => {
    const root = tempDir();
    cleanupDirs.push(root);
    const leaf = join(root, "mid", "leaf");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(root, "fleet.config.json"), JSON.stringify(validConfig));

    vi.spyOn(process, "cwd").mockReturnValue(leaf);

    const { configDir } = loadConfig(undefined);

    expect(configDir).toBe(root);
  });

  it("gives up and reports not-found once it reaches the filesystem root without finding one", () => {
    const root = tempDir();
    cleanupDirs.push(root);
    const leaf = join(root, "mid", "leaf");
    mkdirSync(leaf, { recursive: true });
    // Deliberately no fleet.config.json anywhere under `root`.

    vi.spyOn(process, "cwd").mockReturnValue(leaf);

    expect(() => loadConfig(undefined)).toThrow(/Config not found/);
  });
});
