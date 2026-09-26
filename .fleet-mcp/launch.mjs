// Launches the fleet MCP server for this repo. Stamped by fleet (`sync-templates`
// / `fleet init`) and identical on every machine: nothing here names a path.
// Machine-specific locations live in the gitignored `fleet.config.json`, found
// by searching upward from this repo (or named by FLEET_CONFIG):
//
//   { "fleetDir": "<path to the fleet checkout>", "dashboardPort": 4400,
//     "projects": [{ "name": "<project>", "githubRepo": "owner/name" }] }
//
// `fleetDir` may be omitted when the config sits in the fleet checkout itself.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`fleet mcp launcher: ${message}`);
  process.exit(1);
}

function findConfig(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, "fleet.config.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.FLEET_CONFIG ? resolve(process.env.FLEET_CONFIG) : findConfig(repoDir);
if (!configPath || !existsSync(configPath)) {
  fail(`no fleet.config.json found searching upward from ${repoDir}. Run \`pnpm fleet:init -- --path <this repo>\` from the fleet checkout on this machine.`);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, ""));
} catch (err) {
  fail(`${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
}

const isFleetCheckout = (dir) => existsSync(join(dir, "packages", "mcp", "package.json"));
const fleetDir = config.fleetDir ? resolve(dirname(configPath), config.fleetDir) : dirname(configPath);
if (!isFleetCheckout(fleetDir)) {
  fail(`${fleetDir} is not a fleet checkout — set "fleetDir" in ${configPath} to where fleet is cloned on this machine.`);
}

// `node --import tsx` straight from the MCP package: no pnpm or shell in the
// way, so stdio stays a clean MCP transport and Windows needs no .cmd shim.
const mcpDir = join(fleetDir, "packages", "mcp");
const child = spawn(process.execPath, ["--import", "tsx", join(mcpDir, "src", "index.ts")], {
  cwd: mcpDir,
  stdio: "inherit",
  env: { ...process.env, FLEET_CONFIG: configPath },
});
child.on("error", (err) => fail(err.message));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
