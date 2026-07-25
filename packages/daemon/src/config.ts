import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FleetConfigSchema, type FleetConfig } from "@fleet/shared";

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
  const raw = readFileSync(absolute, "utf8");
  const parsed = FleetConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid config at ${absolute}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return { config: parsed.data, configDir: dirname(absolute) };
}
