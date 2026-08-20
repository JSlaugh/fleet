import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTypeContract, resolveTypeTier } from "./runner.ts";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-typecontract-"));
  dirs.push(dir);
  return dir;
}

function writeFleetYaml(dir: string, spec: unknown): void {
  // JSON is valid YAML — sidesteps YAML-quoting headaches in fixtures.
  writeFileSync(join(dir, "fleet.yaml"), JSON.stringify(spec));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveTypeContract", () => {
  it("is undefined when ticketType is undefined, without touching the filesystem", () => {
    expect(resolveTypeContract("alpha#1", "/does/not/exist", undefined)).toBeUndefined();
  });

  it("is undefined when the worktree has no fleet.yaml", () => {
    const dir = makeTempDir();
    expect(resolveTypeContract("alpha#1", dir, "backend")).toBeUndefined();
  });

  it("returns the matched type's declared contract", () => {
    const dir = makeTempDir();
    writeFleetYaml(dir, {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        backend: {
          setup: [{ name: "install", run: "pnpm install" }],
          contract: "Run the backend test suite before declaring done.",
        },
      },
    });
    expect(resolveTypeContract("alpha#1", dir, "backend")).toBe("Run the backend test suite before declaring done.");
  });

  it("is undefined for a type with no contract key", () => {
    const dir = makeTempDir();
    writeFleetYaml(dir, {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        frontend: [{ name: "install", run: "pnpm install" }],
      },
    });
    expect(resolveTypeContract("alpha#1", dir, "frontend")).toBeUndefined();
  });

  it("fails open (no contract, no throw) when fleet.yaml is malformed at session-open time", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "fleet.yaml"), "setup: not-a-list-or-map\n");
    expect(resolveTypeContract("alpha#1", dir, "backend")).toBeUndefined();
  });
});

describe("resolveTypeTier", () => {
  it("is undefined when ticketType is undefined, without touching the filesystem", () => {
    expect(resolveTypeTier("alpha#1", "/does/not/exist", undefined)).toBeUndefined();
  });

  it("is undefined when the worktree has no fleet.yaml", () => {
    const dir = makeTempDir();
    expect(resolveTypeTier("alpha#1", dir, "docs")).toBeUndefined();
  });

  it("returns the matched type's declared tier", () => {
    const dir = makeTempDir();
    writeFleetYaml(dir, {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        docs: {
          setup: [{ name: "install", run: "pnpm install" }],
          tier: "light",
        },
      },
    });
    expect(resolveTypeTier("alpha#1", dir, "docs")).toBe("light");
  });

  it("is undefined for a type with no tier key", () => {
    const dir = makeTempDir();
    writeFleetYaml(dir, {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        frontend: [{ name: "install", run: "pnpm install" }],
      },
    });
    expect(resolveTypeTier("alpha#1", dir, "frontend")).toBeUndefined();
  });

  it("fails open (no tier, no throw) when fleet.yaml is malformed at session-open time", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "fleet.yaml"), "setup: not-a-list-or-map\n");
    expect(resolveTypeTier("alpha#1", dir, "docs")).toBeUndefined();
  });
});
