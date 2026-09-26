import type { ProjectsOnlyConfig } from "@fleet/shared";

/**
 * Where this MCP process points. `repo` is always present: ticket filing and
 * backlog reads go straight to GitHub. `daemonUrl` is present only when a
 * daemon is configured, and gates the tools that read `fleet.db`.
 */
export interface ResolvedTarget {
  /** `owner/name` */
  repo: string;
  /** The fleet project name, when known — daemon tools that take a project default to it. */
  project?: string;
  daemonUrl?: string;
  /** One line for the startup log, naming where each value came from. */
  describe: string;
}

export interface ResolveEnv {
  FLEET_REPO?: string;
  FLEET_PROJECT?: string;
  FLEET_URL?: string;
  FLEET_CONFIG?: string;
}

export interface ResolveOptions {
  /** Finds and parses `fleet.config.json` (see `config-file.ts`); undefined when there is none. Injected so the rules are testable without a filesystem. */
  loadConfig: (explicitPath: string | undefined) => { path: string; config: ProjectsOnlyConfig } | undefined;
}

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/**
 * Rules, most explicit first:
 *   repo:   FLEET_REPO → else FLEET_PROJECT looked up in a config → else fail.
 *   daemon: FLEET_URL → else a config's dashboardPort on localhost (a full daemon config implies its
 *           default 4400) → else none (a projects-only config never implies a daemon).
 *   project: FLEET_PROJECT → else the config project whose githubRepo is the repo.
 * No probing, no fallback: the tool list must not change between sessions for
 * reasons the agent can't see.
 *
 * With FLEET_REPO set the config is optional (it can only add a daemon and a
 * project name), so a config that fails to parse is reported and skipped
 * rather than taking the whole server down.
 */
export function resolveTarget(env: ResolveEnv, opts: ResolveOptions): ResolvedTarget {
  const sources: string[] = [];
  let loaded: ReturnType<ResolveOptions["loadConfig"]> | undefined;
  let attempted = false;
  const config = () => {
    if (attempted) return loaded;
    attempted = true;
    try {
      loaded = opts.loadConfig(env.FLEET_CONFIG);
    } catch (err) {
      if (!env.FLEET_REPO) throw err;
      sources.push(`config ignored (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
    return loaded;
  };

  let repo: string | undefined;
  let project = env.FLEET_PROJECT;
  if (env.FLEET_REPO) {
    if (!REPO_PATTERN.test(env.FLEET_REPO)) throw new Error(`FLEET_REPO must be owner/name, got "${env.FLEET_REPO}"`);
    repo = env.FLEET_REPO;
    sources.push(`repo ${repo} (FLEET_REPO)`);
  } else if (project) {
    const found = config();
    const entry = found?.config.projects.find((p) => p.name === project);
    if (!found) {
      throw new Error(
        `FLEET_PROJECT=${project} needs a fleet.config.json to look the repo up in (none found${env.FLEET_CONFIG ? ` at ${env.FLEET_CONFIG}` : " searching upward from the current directory"}). Set FLEET_REPO=owner/name instead, or FLEET_CONFIG=/path/to/fleet.config.json.`,
      );
    }
    if (!entry) {
      throw new Error(`FLEET_PROJECT=${project} is not a project in ${found.path} (known: ${found.config.projects.map((p) => p.name).join(", ")})`);
    }
    repo = entry.githubRepo;
    sources.push(`repo ${repo} (project ${project} in ${found.path})`);
  } else {
    throw new Error("Set FLEET_REPO=owner/name, or FLEET_PROJECT=<name> with a fleet.config.json that lists it.");
  }

  let daemonUrl: string | undefined;
  if (env.FLEET_URL) {
    daemonUrl = env.FLEET_URL.replace(/\/+$/, "");
    sources.push(`daemon ${daemonUrl} (FLEET_URL)`);
  } else {
    const found = config();
    const port = found?.config.dashboardPort ?? (found?.config.worktreeRoot ? 4400 : undefined);
    if (found && port !== undefined) {
      daemonUrl = `http://localhost:${port}`;
      sources.push(`daemon ${daemonUrl} (${found.path})`);
    } else {
      sources.push("no daemon (board/history/journal tools off)");
    }
  }

  if (!project) {
    project = config()?.config.projects.find((p) => p.githubRepo === repo)?.name;
  }

  return { repo, project, daemonUrl, describe: sources.join("; ") };
}
