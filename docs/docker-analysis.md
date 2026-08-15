# Fleet — Docker & Isolation Analysis

Follow-up to `roadmap-walkthrough.md` §6, which chose "Docker-first" for the runtime
direction. This analysis examines what containerizing fleet actually implies — in
particular whether a container can carry the tools workers need — and lands on a revised
recommendation. Claude-side facts were verified against official docs (August 2026);
links inline.

---

## 1. "Fleet in Docker" is two different problems

- **Containerizing the daemon** — easy. Its toolset is small and stable: Node + tsx,
  git, `gh`. Any thin image works.
- **Containerizing the workers** — hard, and where the value is. Workers run each
  project's tests, builds, linters, and arbitrary per-package tools (Python, Playwright,
  whatever a repo's verify step needs). Their toolset is unbounded and *per-project*.

The isolation benefit (a hostile or confused ticket can't touch the host — walkthrough
§1) applies to workers, not the daemon. So the worker side decides the architecture.

### The structural catch

The Agent SDK spawns the Claude CLI as a **child process of the daemon**. Wherever the
daemon runs, workers run — put the daemon in a container and every worker inherits that
one container's tools. True per-project worker containers require reworking the runner:
pointing the SDK's `pathToClaudeCodeExecutable` at a wrapper that does
`docker run -i <project-image> claude ...` with stdio piped through. Feasible, but real
plumbing, plus the gotchas in §3.

## 2. Verified facts that change the picture

- **Auth on a Max subscription is solved.** `claude setup-token` officially issues a
  **one-year OAuth token** for subscription accounts, consumed via the
  `CLAUDE_CODE_OAUTH_TOKEN` env var — the documented path for headless/CI use, no API
  keys involved. (No refresh mechanism: regenerate via browser auth yearly.)
  [Authentication docs](https://code.claude.com/docs/en/authentication.md)
- **Official container material exists.** Anthropic publishes a devcontainer feature
  (`ghcr.io/anthropics/devcontainer-features/claude-code`), a hardened reference
  Dockerfile (default-deny egress firewall, non-root user, persistent `~/.claude`
  volume), and Compose/K8s recipes.
  [Dev containers](https://code.claude.com/docs/en/devcontainer.md),
  [deployment recipes](https://code.claude.com/docs/en/self-hosted-environments-deploy.md)
- **Claude Code has native OS sandboxing — no Docker required.** Sandboxed Bash with
  filesystem and network restrictions (`sandbox.filesystem.allowRead/allowWrite` globs,
  `sandbox.network.allowedDomains`), via seatbelt on macOS and bubblewrap on **Linux and
  WSL2**. **Not available on native Windows.**
  [Sandboxing](https://code.claude.com/docs/en/sandboxing.md),
  [sandbox environments](https://code.claude.com/docs/en/sandbox-environments.md)
- **Windows guidance favors WSL2.** Repos kept *inside* the WSL2 filesystem run at
  native speed; Windows-filesystem folders accessed across the boundary go through a
  network filesystem — slow, and file watching breaks.
  [Setup — Windows](https://code.claude.com/docs/en/setup.md),
  [Desktop + WSL](https://code.claude.com/docs/en/desktop-wsl.md)

## 3. The two real gotchas for containerized workers

- **Worktrees break when mounted (confirmed real, undocumented).** A worktree's `.git`
  file stores an *absolute host path* to the main repo's `.git` directory. Mount only
  the worktree into a container and git fails (`not a git repository`). Fixes: mount
  repo + worktrees at identical absolute paths inside the container, or create the
  worktree inside the container itself — either way `worktree.ts` becomes
  container-aware. Official docs don't cover this case; worth filing via `/feedback`.
- **The fleet MCP loop needs network plumbing.** Workers reach the daemon's REST API
  (`fleet_file_ticket` etc.) at `localhost:4400`; from inside a container that becomes
  `host.docker.internal` (Docker Desktop) — the stamped `.mcp.json` template and
  `FLEET_URL` need to account for where the worker runs.

## 4. The tooling question, answered directly

> "The container would have a hard time having all of the tools I use locally — would
> that be a problem?"

**Yes — if the design is one shared image.** That's the classic CI-image trap: the image
bloats toward gigabytes, still misses the one tool some package needs, and becomes a
snowflake to maintain. The two honest ways out:

1. **Per-project environments.** Each repo declares its own toolchain — the natural
   vehicle is `.devcontainer/devcontainer.json` *in the target repo*, which matches
   fleet's existing philosophy (workers already load the target repo's `.claude/`
   setup; repos self-describe). Fleet config references each project's image the way
   `setupCommand` works today.
2. **Don't containerize the toolchain at all.** Run workers where the tools already
   are (like today), and get isolation from native sandboxing instead.

A single fat image is explicitly rejected.

## 5. Options compared

| Option | Isolation | Tooling problem | Effort | Restart/deploy story |
|---|---|---|---|---|
| **0. Status quo** — daemon on native Windows | none | none | — | supervisor wrapper (walkthrough §6-A) |
| **1. Fleet inside WSL2, no Docker** | per-command sandboxed Bash (bubblewrap): FS + network limits per worker | **none** — install your tools once in the distro, same model as today | low: move repos + daemon into WSL2, enable sandbox settings | supervisor wrapper still the mechanism |
| **2. Daemon native/WSL2, workers in per-project containers** | full process isolation | solved per-repo via devcontainer images | high: runner rework (`docker run` wrapper), worktree path fix, MCP networking | partial (worker images restart; daemon still needs a supervisor) |
| **3. Everything in one container** | full | **the fat-image trap** — worst fit for multi-project fleet | medium | container restart policy |

## 6. Recommendation

**Option 1 now; option 2 later, if and when multi-user or hostile-input hardening
becomes real.**

- Moving fleet into WSL2 delivers most of the isolation value (filesystem + network
  sandboxing on every worker Bash command) with **zero** tooling cost — the distro is
  set up once with Python/Node/everything, exactly like the current machine. Fleet's
  code changes barely at all (sandbox settings can ride the target repo's `.claude/`
  or the worker session options).
- It's also the prerequisite groundwork for option 2: repos living inside the WSL2
  filesystem is what makes container bind mounts fast later.
- When per-project containers do land, each repo carries its own devcontainer, so the
  tooling question is answered *by the project, per project* — never by one shared
  image.
- macOS support (walkthrough §6 goal) falls out naturally: seatbelt sandboxing there
  is built-in, no setup at all.

### Revision to walkthrough §6

The walkthrough chose "Docker-first (C), supervisor wrapper (A) as fallback." This
analysis flips the near term: **option 1 provides no container runtime to act as
supervisor, so the supervisor wrapper (A) is back to being the restart mechanism now**
— it's ~50 lines, serves crash recovery + `fleet update` + fleet-on-fleet deploys, and
survives unchanged into an eventual option-2 world (only the daemon's relauncher would
change). The `setup-token` verification stays valuable: it's needed the moment any
worker runs where the interactive login doesn't exist — containers later, possibly a
second machine sooner.

### Sequenced

1. Supervisor wrapper + `POST /api/daemon/restart` + `fleet update` (unblocks clean
   fleet-on-fleet deploys today, on any option).
2. Migrate fleet + repos into WSL2; enable sandboxed Bash for workers; document the
   distro setup as the "worker environment" definition.
3. Generate and stash a `setup-token`; verify a worker session runs headless with it
   (cheap experiment, de-risks everything container-shaped).
4. Revisit per-project containers only alongside the multi-daemon work (walkthrough
   §1), where process-level isolation and per-repo environments earn their complexity.
