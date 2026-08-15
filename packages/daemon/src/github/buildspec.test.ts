import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBuildSpec, readBuildSpec } from "./buildspec.ts";

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
