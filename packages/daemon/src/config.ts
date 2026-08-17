import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findUnknownConfigKeys, FleetConfigSchema, type FleetConfig } from "@fleet/shared";
import { log } from "./log.ts";

export interface LoadedConfig {
  config: FleetConfig;
  configDir: string;
}

function findDefaultConfig(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "fleet.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(configPath: string | undefined): LoadedConfig {
  const absolute = configPath ? resolve(configPath) : findDefaultConfig();
  if (!absolute || !existsSync(absolute)) {
    throw new Error(
      `Config not found${absolute ? ` at ${absolute}` : ""} (searched upward from ${process.cwd()}). Copy fleet.config.example.json to fleet.config.json and edit it.`,
    );
  }
  // Windows tooling (PowerShell 5.1's -Encoding utf8, some editors) writes a
  // UTF-8 BOM, which JSON.parse rejects. StateStore strips it too.
  const raw = readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
  const json = JSON.parse(raw);
  const parsed = FleetConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${absolute}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  for (const key of findUnknownConfigKeys(FleetConfigSchema, json)) {
    log("config", `Unknown key "${key}" in ${absolute} \u2014 ignored. Check for a typo against fleet.config.example.json.`);
  }
  return { config: parsed.data, configDir: dirname(absolute) };
}
