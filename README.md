# Fleet

Multi-project Claude Code backlog orchestrator: GitHub Issues in, reviewed PRs out.

The daemon polls registered repos for open issues labeled `fleet:ready`, claims each one into its own git worktree, runs it as a Claude Agent SDK session, and ends every ticket at a pull request for human review. Progress and blockers are written back to the issue as a single continuously-updated status comment.

## How a ticket flows

1. You label an open issue `fleet:ready` (optionally `fleet:p1`/`p2`/`p3` for priority).
2. The daemon claims it (`fleet:in-progress`), creates a worktree + `fleet/<issue>` branch, and spawns a worker session with the issue text as its prompt.
3. The worker commits incrementally and finishes with a structured result.
4. Completed → branch pushed, PR opened, issue labeled `fleet:review`. Blocked → issue labeled `fleet:needs-input` with the worker's question in the status comment.
5. You review the PR (or answer the question and re-label `fleet:ready`).

## Setup

```bash
pnpm install
gh auth login        # the daemon shells out to gh for all GitHub access
cp fleet.config.example.json fleet.config.json   # then edit
pnpm daemon init-labels                          # creates fleet:* labels in each repo
```

## Running

```bash
pnpm daemon -- --dry-run --once   # poll and report what would be claimed; changes nothing
pnpm daemon -- --once             # one cycle: claim, run workers to completion, exit
pnpm daemon                       # the real loop + dashboard at http://localhost:4400
```

The daemon serves the dashboard (build it once with `pnpm dashboard:build`) and a REST/WS API: `GET /api/board`, `GET /api/tickets/:project/:issue` (record + transcript tail), `POST /api/tickets/:project/:issue/priority`, and `/ws` pushing `board-updated` events. For dashboard development, `pnpm dashboard:dev` runs Vite on :4401 proxying to the daemon.

Operational state lives in `.fleet/` (ticket records in `state.json`, per-ticket session journals in `journals/`). The source of truth for tickets is always GitHub.

## Config

See `fleet.config.example.json`. Per project: `repoPath` (local clone), `githubRepo` (`owner/repo`), `defaultBranch`, `maxConcurrent`, optional `setupCommand` (run in each fresh worktree, e.g. `pnpm install`), optional `model` and `allowedTools` overrides.

## Roadmap

- ~~Phase 0: walking-skeleton daemon, no UI.~~ Done — verified end-to-end (issue → worker → PR).
- ~~Phase 1: REST/WS API, Vue dashboard (board + ticket detail).~~ Done.
- ~~Phase 2: needs-input steering, approvals inbox, worker questions answered from the dashboard.~~ Done.
- ~~Phase 3: model visibility, live activity notes, stall recovery, merged-worktree cleanup, cost totals.~~ Done.

## Skills, agents, and models

Workers load each project's own `.claude/` setup (`settingSources: ['project']`): CLAUDE.md instructions, **skills** (`.claude/skills/`), and **subagents** (`.claude/agents/`) all work inside worker sessions, auto-triggering from their descriptions exactly like interactive Claude Code. The `Skill`/`Agent` tools are in the default worker allowlist.

Model selection is layered, most specific wins:

1. **Skills and agents in the repo** — `model:` frontmatter in a SKILL.md or agent .md pins the model for that skill/agent's work. This is the recommended place to encode "this kind of task needs this model."
2. **`fleet:elevate` label** on an issue — runs that ticket's session on the project's `elevatedModel` (config). Add the label + reply to a blocked ticket to retry harder with a stronger model.
3. **Per-project `model`** in the config — the session default for all of that project's workers; unset means the Claude CLI's configured default.

The model actually used shows on each board card and in ticket detail, with a per-model token/cost breakdown after each run (subagent models included).
