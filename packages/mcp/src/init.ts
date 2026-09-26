import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AGENT_KINDS, agentsFor, type AgentKind } from "@fleet/shared";
import { findConfigFile, readProjectsConfig } from "./config-file.ts";
import { FLEET_DIR, buildFleetEntry, stampProject } from "./stamp/index.ts";

/**
 * `fleet init`: stamp one repo for Claude and/or Codex without a daemon.
 * Same stampers `pnpm daemon sync-templates` uses; the only difference is
 * where the project list comes from — here, a projects-only
 * `fleet.config.json` (found by the upward search from the repo, or written
 * for the user from `--repo`), never the daemon's full config.
 */

const USAGE = `Usage:
  fleet init [--path <repo-dir>] [--repo owner/name] [--project <name>] [--agents claude,codex] [--config <fleet.config.json>] [--daemon-url <url>]

  Relative paths resolve against the directory pnpm was run in (INIT_CWD), not packages/mcp. With
  \`pnpm --dir <fleet-checkout>\` that directory is the fleet checkout, so pass an absolute --path.

  --path      the repo's working tree to stamp (default: the directory you ran pnpm from)
  --repo      owner/name; with no config found, writes a minimal fleet.config.json next to the repo listing just this project
  --project   which project in the config to stamp for (default: the only one, or the one whose githubRepo matches --repo)
  --agents    comma-separated (${AGENT_KINDS.join(", ")}); default: the project's agents from the config, else claude
  --config    explicit fleet.config.json path (default: search upward from --path)
  --daemon-url  stamp FLEET_URL so board/history tools register (default: http://localhost:<dashboardPort> when the config names one)
`;

export interface InitArgs {
  path: string;
  repo?: string;
  project?: string;
  agents?: AgentKind[];
  config?: string;
  daemonUrl?: string;
  /** Whether --path was given, as opposed to defaulting to the invocation directory. */
  pathGiven: boolean;
  help: boolean;
}

/**
 * `pnpm fleet:init` runs via `pnpm --filter @fleet/mcp`, so `process.cwd()` is
 * always `packages/mcp`; pnpm exposes the directory the user actually ran it
 * from as INIT_CWD.
 */
export function invocationDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.INIT_CWD ?? process.cwd();
}

export function parseInitArgs(argv: string[], cwd: string = invocationDir()): InitArgs {
  const args: InitArgs = { path: cwd, pathGiven: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--path") {
      args.path = resolve(cwd, next());
      args.pathGiven = true;
    }
    else if (arg === "--repo") args.repo = next();
    else if (arg === "--project") args.project = next();
    else if (arg === "--config") args.config = resolve(cwd, next());
    else if (arg === "--daemon-url") args.daemonUrl = next().replace(/\/+$/, "");
    else if (arg === "--agents") {
      args.agents = next().split(",").map((s) => s.trim()).filter(Boolean) as AgentKind[];
      for (const a of args.agents) {
        if (!(AGENT_KINDS as readonly string[]).includes(a)) throw new Error(`unknown agent "${a}" (expected ${AGENT_KINDS.join(" or ")})`);
      }
    } else if (arg !== "init") throw new Error(`unknown argument ${arg}`);
  }
  if (args.repo && !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) throw new Error(`--repo must be owner/name, got "${args.repo}"`);
  return args;
}

export function runInit(args: InitArgs, out: (line: string) => void = (l) => console.error(l)): void {
  if (!existsSync(args.path)) throw new Error(`${args.path} does not exist`);
  // `pnpm --dir <fleet-checkout> fleet:init` reports the fleet checkout as the
  // invocation directory, so a defaulted path there almost certainly meant
  // "the repo I ran this from", which pnpm no longer knows.
  if (!args.pathGiven && resolve(args.path) === resolve(FLEET_DIR)) {
    throw new Error("Refusing to stamp the fleet checkout itself. Pass --path <target-repo> (absolute when using pnpm --dir).");
  }

  let configPath = findConfigFile(args.path, args.config);
  if (!configPath) {
    if (!args.repo) {
      throw new Error("No fleet.config.json found searching upward from the repo. Pass --repo owner/name to have one written, or --config <path>.");
    }
    configPath = join(args.path, "fleet.config.json");
    const projectName = args.project ?? basename(args.repo);
    const minimal = {
      agents: args.agents ?? ["claude"],
      projects: [{ name: projectName, githubRepo: args.repo }],
    };
    writeFileSync(configPath, `${JSON.stringify(minimal, null, 2)}\n`);
    out(`wrote ${configPath} (projects-only; the daemon would need more, the MCP does not)`);
    out("note: fleet.config.json is machine-local — gitignore it rather than committing it");
  }

  const config = readProjectsConfig(configPath);
  const project =
    config.projects.find((p) => p.name === args.project) ??
    (args.repo ? config.projects.find((p) => p.githubRepo === args.repo) : undefined) ??
    (config.projects.length === 1 ? config.projects[0] : undefined);
  if (!project) {
    throw new Error(`Which project? ${configPath} lists ${config.projects.map((p) => p.name).join(", ")} — pass --project <name>.`);
  }
  if (args.project && project.name !== args.project) throw new Error(`no project named ${args.project} in ${configPath}`);

  const agents = args.agents ?? agentsFor(project, config);
  const daemonUrl = args.daemonUrl ?? (config.dashboardPort !== undefined ? `http://localhost:${config.dashboardPort}` : undefined);
  if (!daemonUrl) {
    out("note: no daemon URL stamped (the config names no dashboardPort) — board/history tools stay off; pass --daemon-url http://localhost:4400 if a daemon manages this project");
  }
  const result = stampProject(args.path, agents, buildFleetEntry({ project: project.name, configPath, daemonUrl }));
  for (const path of result.written) out(`wrote ${path}`);
  for (const note of result.notes) out(`note: ${note}`);
  out(`done — stamped ${project.name} (${project.githubRepo}) for ${agents.join(", ")}; these are working-tree changes, review and commit them`);
}

if (process.argv[1] && basename(process.argv[1]) === "init.ts") {
  try {
    const args = parseInitArgs(process.argv.slice(2).filter((a) => a !== "--"));
    if (args.help) console.log(USAGE);
    else runInit(args);
  } catch (err) {
    console.error(`fleet init: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
