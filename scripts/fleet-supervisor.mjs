#!/usr/bin/env node
// Plain Node relauncher for `pnpm daemon` — no tsx/TS build step needed to run
// this file. Going through `pnpm daemon` (not the daemon package directly) is
// deliberate: turbo rebuilds the dashboard first on each launch (a cached
// no-op when nothing changed), so a relaunch after `git pull` always ships
// fresh UI. See `packages/daemon/src/restart-code.ts` for the exit-code
// contract this implements (RESTART_EXIT_CODE must match `supervisor-policy.mjs`).
import { spawn } from "node:child_process";
import { BASE_BACKOFF_MS, decideNextAction } from "./supervisor-policy.mjs";

const extraArgs = process.argv.slice(2);
const PNPM_CMD = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const IS_WINDOWS = process.platform === "win32";

function log(message) {
  console.log(`[fleet-supervisor] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `pnpm.cmd` can't be spawned directly on Windows without `shell: true`
 * (`EINVAL` — CreateProcess doesn't understand .cmd files). But `shell: true`
 * combined with a separate args array makes Node concatenate them into the
 * shell command line unescaped (Node's own DEP0190 warning), which is a
 * command-injection footgun once `extraArgs` are in the mix. So on Windows we
 * quote each argument ourselves and hand `spawn` one pre-built command
 * string instead of an args array.
 */
function winQuoteArg(arg) {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Spawns `pnpm daemon` once and resolves with its exit code once it exits. */
function runOnce() {
  return new Promise((resolve) => {
    const args = ["daemon", "--", ...extraArgs];
    const child = IS_WINDOWS
      ? spawn([PNPM_CMD, ...args].map(winQuoteArg).join(" "), { stdio: "inherit", shell: true })
      : spawn(PNPM_CMD, args, { stdio: "inherit" });

    const forward = (signal) => {
      if (IS_WINDOWS) {
        if (signal === "SIGINT") {
          // Nothing to do: a real Ctrl+C at an attached console is a Windows
          // console-control event, broadcast by the OS to every process
          // sharing that console — the whole pnpm/turbo/tsx chain down to the
          // daemon already got it natively, same moment we did. Explicitly
          // calling child.kill() here would NOT forward it gracefully: Node
          // documents subprocess.kill() on Windows as an unconditional,
          // forceful termination for any signal name, and it only reaches
          // the immediate cmd.exe wrapper — it would race ahead of, not
          // assist, the daemon's own graceful stop-now, and orphan every
          // descendant process below the wrapper (verified manually: it
          // leaves the real daemon process running and still holding the
          // dashboard port). Just keep this listener registered so Node
          // doesn't apply its own default (process.exit) behavior — that
          // would abandon the loop below before it can see the daemon's
          // real exit code and decide not to relaunch.
          log("SIGINT received — daemon already got it via the shared console; waiting for it to stop");
          return;
        }
        // SIGTERM has no console-control equivalent and no graceful delivery
        // path on Windows at all. taskkill /T is the only way to reach the
        // whole tree instead of leaving the daemon orphaned mid-shutdown; it
        // is a hard kill, not a graceful one — the next boot's
        // `StateStore.clearLiveFlags()` reconciles anything left running.
        log(`${signal} received — no graceful signal exists on Windows; force-killing the process tree`);
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        return;
      }
      log(`${signal} received — forwarding to daemon`);
      child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      // A signal-killed child (no exit code) is treated as a crash, same as
      // any other unexpected nonzero exit — a clean stop always exits 0 itself.
      resolve(code ?? 1);
    });

    child.on("error", (err) => {
      log(`failed to spawn daemon: ${err.message}`);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(1);
    });
  });
}

async function main() {
  log(`starting daemon (pnpm daemon${extraArgs.length ? ` -- ${extraArgs.join(" ")}` : ""})`);
  let backoffMs = BASE_BACKOFF_MS;

  for (;;) {
    const startedAt = Date.now();
    const code = await runOnce();
    const uptimeMs = Date.now() - startedAt;
    const decision = decideNextAction({ code, uptimeMs, backoffMs });

    if (decision.action === "stop") {
      log("daemon exited cleanly (0) — stopping, not relaunching");
      process.exit(0);
    }

    backoffMs = decision.nextBackoffMs;
    if (decision.delayMs === 0) {
      log("restart requested — relaunching immediately");
    } else {
      log(`daemon crashed (exit ${code}) after ${Math.round(uptimeMs / 1000)}s — relaunching in ${Math.round(decision.delayMs / 1000)}s`);
      await delay(decision.delayMs);
    }
  }
}

main();
