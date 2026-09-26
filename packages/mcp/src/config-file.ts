import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectsOnlyConfigSchema, type ProjectsOnlyConfig } from "@fleet/shared";

/**
 * Same upward search the daemon's `loadConfig` does (deliberately duplicated:
 * it is eight lines, and sharing it would drag `node:fs` into `@fleet/shared`,
 * which the dashboard bundles). An explicit path wins over the search.
 */
export function findConfigFile(startDir: string, explicit?: string): string | undefined {
  if (explicit) {
    const absolute = resolve(explicit);
    return existsSync(absolute) ? absolute : undefined;
  }
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "fleet.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Lenient parse: only the projects-level fields the MCP needs are validated. */
export function readProjectsConfig(path: string): ProjectsOnlyConfig {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  const parsed = ProjectsOnlyConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${path} is not a usable fleet config:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
    );
  }
  return parsed.data;
}
