import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalManager } from "./session/approvals.ts";
import { loadConfig } from "./config.ts";
import { ensureLabels, getAuthenticatedLogin } from "./github/github.ts";
import { FleetLoop } from "./loop/loop.ts";
import { log, logError, suppressCanUseToolShadowedWarning } from "./log.ts";
import { startServer } from "./server/server.ts";
import { StateStore } from "./store/state.ts";
import { syncTemplates } from "./sync-templates.ts";
import { parseUpdateArgs, performUpdate } from "./update.ts";

const USAGE = `Usage:
  fleet-daemon [--config <path>] [--once] [--dry-run]   run the polling loop
  fleet-daemon init-labels [--config <path>]            create fleet:* labels in every configured repo
  fleet-daemon sync-templates [--config <path>]         stamp the fleet skill + .mcp.json into every configured repo
  fleet-daemon update [--config <path>] [--drain]        pull latest, install, restart the running daemon

Options:
  --config <path>   path to fleet.config.json (default: ./fleet.config.json)
  --once            run a single polling cycle, wait for workers, then exit
  --dry-run         poll and report what would be claimed, but change nothing
  --drain           (update only) request a drain-mode restart instead of stopping now
`;

async function main(): Promise<void> {
  suppressCanUseToolShadowedWarning();

  // `pnpm daemon -- <args>` forwards the `--` separator through turbo verbatim; drop it
  // so subcommand dispatch below still sees the subcommand as args[0].
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
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
    await syncTemplates(config.projects, { port: config.dashboardPort });
    return;
  }

  if (args[0] === "update") {
    const { drain } = parseUpdateArgs(args.slice(1));
    const exitCode = await performUpdate(configDir, config.dashboardPort, drain);
    process.exitCode = exitCode;
    return;
  }

  // Resolved once here (and cached for the process's lifetime by `getAuthenticatedLogin`
  // itself) rather than lazily on a project's first auto-merge check, so a `gh` auth
  // problem surfaces at boot instead of silently blocking the first eligible merge.
  if (config.projects.some((p) => p.autoMerge && (!p.approvers || p.approvers.length === 0))) {
    const login = await getAuthenticatedLogin();
    log("daemon", `auto-merge default approver resolved from gh auth: @${login}`);
  }

  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");
  const dataDir = join(configDir, config.dataDir);
  const state = new StateStore(dataDir);
  state.clearLiveFlags();
  const approvals = new ApprovalManager();
  const loop = new FleetLoop(config, state, dataDir, approvals, dryRun, once);
  await loop.refreshBootHeartbeats();
  await loop.recoverPendingTeardowns();

  log("daemon", `fleet daemon starting — ${config.projects.length} project(s), poll every ${config.pollIntervalSeconds}s${dryRun ? " [dry-run]" : ""}${once ? " [once]" : ""}`);

  if (once) {
    await loop.cycle();
    await loop.drain();
    log("daemon", "single cycle complete");
    return;
  }

  const dashboardDist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "dashboard", "dist");
  startServer({ port: config.dashboardPort, loop, state, approvals, dataDir, dashboardDist });

  // Ctrl+C (or a process manager's SIGTERM) is a stop-now: abort live sessions
  // rather than let the OS kill them mid-turn, so the next boot can auto-resume
  // each of them instead of burning their once-only stall recovery on top of
  // an unclean crash. Shares `beginShutdown`'s guard with the HTTP endpoint, so
  // a second signal (or a shutdown already requested from the dashboard) is a
  // no-op rather than a second, overlapping abort pass.
  const onStopSignal = (signal: string) => {
    if (!loop.beginShutdown()) return;
    log("daemon", `${signal} received — stopping now (live sessions abort; each auto-resumes once on the next boot)`);
    void loop.shutdownNow().then(() => {
      log("daemon", "stop-now complete — exiting");
      process.exit(0);
    });
  };
  process.on("SIGINT", () => onStopSignal("SIGINT"));
  process.on("SIGTERM", () => onStopSignal("SIGTERM"));

  for (;;) {
    if (loop.isShuttingDown) break;
    await loop.cycle();
    if (loop.isShuttingDown) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalSeconds * 1000));
  }
}

main().catch((err) => {
  logError("daemon", "fatal", err);
  process.exitCode = 1;
});
