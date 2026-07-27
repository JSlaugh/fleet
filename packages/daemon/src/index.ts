import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalManager } from "./approvals.ts";
import { loadConfig } from "./config.ts";
import { ensureLabels } from "./github.ts";
import { FleetLoop } from "./loop.ts";
import { log, logError } from "./log.ts";
import { startServer } from "./server.ts";
import { StateStore } from "./state.ts";
import { syncTemplates } from "./sync-templates.ts";

const USAGE = `Usage:
  fleet-daemon [--config <path>] [--once] [--dry-run]   run the polling loop
  fleet-daemon init-labels [--config <path>]            create fleet:* labels in every configured repo
  fleet-daemon sync-templates [--config <path>]         stamp the fleet skill + .mcp.json into every configured repo

Options:
  --config <path>   path to fleet.config.json (default: ./fleet.config.json)
  --once            run a single polling cycle, wait for workers, then exit
  --dry-run         poll and report what would be claimed, but change nothing
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const configIndex = args.indexOf("--config");
  const configPath = configIndex !== -1 ? args[configIndex + 1] : undefined;
  const { config, configDir } = loadConfig(configPath);

  if (args[0] === "init-labels") {
    for (const project of config.projects) {
      log("labels", `ensuring fleet labels in ${project.githubRepo}`);
      await ensureLabels(project);
    }
    log("labels", "done");
    return;
  }

  if (args[0] === "sync-templates") {
    await syncTemplates(config.projects);
    return;
  }

  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");
  const dataDir = join(configDir, config.dataDir);
  const state = new StateStore(dataDir);
  state.clearLiveFlags();
  const approvals = new ApprovalManager();
  const loop = new FleetLoop(config, state, dataDir, approvals, dryRun);

  log("daemon", `fleet daemon starting — ${config.projects.length} project(s), poll every ${config.pollIntervalSeconds}s${dryRun ? " [dry-run]" : ""}${once ? " [once]" : ""}`);

  if (once) {
    await loop.cycle();
    await loop.drain();
    log("daemon", "single cycle complete");
    return;
  }

  const dashboardDist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "dashboard", "dist");
  startServer({ port: config.dashboardPort, loop, state, approvals, dataDir, dashboardDist });

  for (;;) {
    await loop.cycle();
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalSeconds * 1000));
  }
}

main().catch((err) => {
  logError("daemon", "fatal", err);
  process.exitCode = 1;
});
