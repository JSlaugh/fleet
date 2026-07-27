import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FleetConfigSchema, ProjectConfigSchema } from "./index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const examplePath = join(repoRoot, "fleet.config.example.json");

describe("fleet.config.example.json", () => {
  it("has no UTF-8 BOM", () => {
    const bytes = readFileSync(examplePath);
    expect(bytes[0]).not.toBe(0xef);
  });

  it("parses against FleetConfigSchema", () => {
    const raw = readFileSync(examplePath, "utf8");
    expect(() => FleetConfigSchema.parse(JSON.parse(raw))).not.toThrow();
  });

  it("covers every top-level schema field", () => {
    const raw = readFileSync(examplePath, "utf8");
    const example = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(FleetConfigSchema.shape)) {
      expect(Object.keys(example), `missing top-level field "${key}"`).toContain(key);
    }
  });

  it("covers every project-level schema field", () => {
    const raw = readFileSync(examplePath, "utf8");
    const example = JSON.parse(raw) as { projects: Record<string, unknown>[] };
    for (const project of example.projects) {
      for (const key of Object.keys(ProjectConfigSchema.shape)) {
        expect(Object.keys(project), `missing project field "${key}"`).toContain(key);
      }
    }
  });
});
