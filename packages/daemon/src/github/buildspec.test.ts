import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBuildSpec, readBuildSpec, resolveTypeChecklist, resolveTypeVerify } from "./buildspec.ts";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-buildspec-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseBuildSpec", () => {
  it("parses a bare step list", () => {
    const spec = parseBuildSpec("setup:\n  - name: install\n    run: pnpm install\n");
    expect(spec.setup).toEqual([{ name: "install", run: "pnpm install" }]);
  });

  it("parses a profile map", () => {
    const spec = parseBuildSpec(
      [
        "setup:",
        "  default:",
        "    - name: install",
        "      run: pnpm install",
        "  frontend:",
        "    - name: install",
        "      run: pnpm install",
        "    - name: build-storybook",
        "      run: pnpm --filter web build-storybook",
      ].join("\n"),
    );
    expect(Object.keys(spec.setup as Record<string, unknown>)).toEqual(["default", "frontend"]);
  });

  it("throws a clear error on unparseable YAML", () => {
    expect(() => parseBuildSpec("setup: [\n  - broken")).toThrow(/not valid YAML/);
  });

  it("throws a clear error on a schema-invalid document", () => {
    expect(() => parseBuildSpec("setup:\n  frontend:\n    - name: install\n      run: pnpm install\n")).toThrow(
      /fleet\.yaml is invalid/,
    );
  });

  it("throws on a document with no setup key at all", () => {
    expect(() => parseBuildSpec("foo: bar\n")).toThrow(/fleet\.yaml is invalid/);
  });
});

describe("readBuildSpec", () => {
  it("returns undefined when fleet.yaml does not exist", () => {
    const dir = makeTempDir();
    expect(readBuildSpec(dir)).toBeUndefined();
  });

  it("reads and parses fleet.yaml from the repo root", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "fleet.yaml"), "setup:\n  - name: install\n    run: pnpm install\n");
    const spec = readBuildSpec(dir);
    expect(spec?.setup).toEqual([{ name: "install", run: "pnpm install" }]);
  });

  it("throws when fleet.yaml exists but is malformed", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "fleet.yaml"), "setup: not-a-list-or-map\n");
    expect(() => readBuildSpec(dir)).toThrow(/fleet\.yaml is invalid/);
  });
});

describe("resolveTypeChecklist", () => {
  it("is undefined when ticketType is undefined, without touching the filesystem", () => {
    expect(resolveTypeChecklist("alpha#1", "/does/not/exist", undefined)).toBeUndefined();
  });

  it("is undefined when the worktree has no fleet.yaml", () => {
    const dir = makeTempDir();
    expect(resolveTypeChecklist("alpha#1", dir, "dashboard")).toBeUndefined();
  });

  it("returns the matched type's declared review checklist", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "fleet.yaml"),
      JSON.stringify({
        setup: {
          default: [{ name: "install", run: "pnpm install" }],
          dashboard: {
            setup: [{ name: "install", run: "pnpm install" }],
            review: "Check accessibility and dark-mode theming.",
          },
        },
      }),
    );
    expect(resolveTypeChecklist("alpha#1", dir, "dashboard")).toBe("Check accessibility and dark-mode theming.");
  });

  it("is undefined for a type with no review key", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "fleet.yaml"),
      JSON.stringify({
        setup: {
          default: [{ name: "install", run: "pnpm install" }],
          frontend: [{ name: "install", run: "pnpm install" }],
        },
      }),
    );
    expect(resolveTypeChecklist("alpha#1", dir, "frontend")).toBeUndefined();
  });

  it("fails open (no checklist, no throw) when fleet.yaml is malformed at review time", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "fleet.yaml"), "setup: not-a-list-or-map\n");
    expect(resolveTypeChecklist("alpha#1", dir, "dashboard")).toBeUndefined();
  });
});

describe("resolveTypeVerify", () => {
  it("is undefined when ticketType is undefined, without touching the filesystem", () => {
    expect(resolveTypeVerify("alpha#1", "/does/not/exist", undefined)).toBeUndefined();
  });

  it("is undefined when the worktree has no fleet.yaml", () => {
    const dir = makeTempDir();
    expect(resolveTypeVerify("alpha#1", dir, "daemon")).toBeUndefined();
  });

  it("returns the matched type's declared verify commands", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "fleet.yaml"),
      JSON.stringify({
        setup: {
          default: [{ name: "install", run: "pnpm install" }],
          daemon: {
            setup: [{ name: "install", run: "pnpm install" }],
            verify: ["pnpm --filter @fleet/daemon typecheck", "pnpm --filter @fleet/daemon test"],
          },
        },
      }),
    );
    expect(resolveTypeVerify("alpha#1", dir, "daemon")).toEqual(["pnpm --filter @fleet/daemon typecheck", "pnpm --filter @fleet/daemon test"]);
  });

  it("is undefined for a type with no verify key", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "fleet.yaml"),
      JSON.stringify({
        setup: {
          default: [{ name: "install", run: "pnpm install" }],
          frontend: [{ name: "install", run: "pnpm install" }],
        },
      }),
    );
    expect(resolveTypeVerify("alpha#1", dir, "frontend")).toBeUndefined();
  });

  it("fails open (no verify commands, no throw) when fleet.yaml is malformed at session-open time", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "fleet.yaml"), "setup: not-a-list-or-map\n");
    expect(resolveTypeVerify("alpha#1", dir, "daemon")).toBeUndefined();
  });
});
