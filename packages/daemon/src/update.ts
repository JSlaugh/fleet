import { runShell } from "./github/exec.ts";
import { log, logError } from "./log.ts";

export interface UpdateArgs {
  drain: boolean;
}

export function parseUpdateArgs(args: string[]): UpdateArgs {
  return { drain: args.includes("--drain") };
}

export interface UpdateDeps {
  runShell: typeof runShell;
  fetchImpl: typeof fetch;
}

const defaultDeps: UpdateDeps = { runShell, fetchImpl: fetch };

/**
 * `git pull --ff-only` + `pnpm install` + a daemon restart request, run in
 * that order. Returns a process exit code rather than throwing — an
 * unreachable daemon (nothing running) is a successful update, not a
 * failure, so the caller needs the distinction back as data.
 */
export async function performUpdate(repoDir: string, dashboardPort: number, drain: boolean, deps: UpdateDeps = defaultDeps): Promise<number> {
  log("update", `pulling latest in ${repoDir} (git pull --ff-only)`);
  try {
    const { stdout } = await deps.runShell("git pull --ff-only", repoDir);
    log("update", stdout.trim() || "pull complete");
  } catch (err) {
    logError(
      "update",
      "git pull --ff-only failed — local commits or a dirty tree diverge from origin; resolve manually, fleet never merges or rebases automatically",
      err,
    );
    return 1;
  }

  log("update", "installing dependencies (pnpm install)");
  try {
    await deps.runShell("pnpm install", repoDir);
  } catch (err) {
    logError("update", "pnpm install failed", err);
    return 1;
  }

  const mode = drain ? "drain" : "now";
  log("update", `requesting daemon restart (${mode})`);
  let res: Response;
  try {
    res = await deps.fetchImpl(`http://localhost:${dashboardPort}/api/daemon/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch {
    // Connection refused (or any other fetch failure) means nothing is
    // listening — a supervised daemon just isn't running right now, which
    // isn't a failed update.
    log("update", "updated; daemon not running, start it with `pnpm daemon:supervised`");
    return 0;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logError("update", `daemon restart request rejected (${res.status})${body ? `: ${body}` : ""}`);
    return 1;
  }

  log("update", "updated; daemon restart requested");
  return 0;
}
