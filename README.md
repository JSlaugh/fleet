# Fleet

Multi-project Claude Code backlog orchestrator: GitHub Issues in, reviewed PRs out.

The daemon polls registered repos for open issues labeled `fleet:ready`, claims each one into its own git worktree, runs it as a Claude Agent SDK session, and ends every ticket at a pull request for human review. Progress and blockers are written back to the issue as a single continuously-updated status comment.

## How a ticket flows

1. You label an open issue `fleet:ready` (optionally `fleet:p1`/`p2`/`p3` for priority; `Depends-on: #12` in the body holds it until #12 closes).
2. The daemon claims it (`fleet:in-progress`), creates a worktree + `fleet/<issue>` branch, and spawns a worker session with the issue text as its prompt. A `fleet:plan` issue instead spawns a read-only planning session that decomposes the epic into child tickets — see [Epic decomposition](#epic-decomposition-fleetplan) below.
3. The worker commits incrementally and finishes with a structured result.
4. Completed → branch pushed, PR opened, issue labeled `fleet:review`. Blocked → issue labeled `fleet:needs-input` with the worker's question in the status comment.
5. You review the PR (or answer the question and re-label `fleet:ready`). Changes-requested reviews or new inline comments on an open fleet PR are picked up automatically and resume the same session — see [Review feedback and recovery](#review-feedback-and-recovery).

## Setup

```bash
pnpm install
gh auth login        # the daemon shells out to gh for all GitHub access
cp fleet.config.example.json fleet.config.json   # then edit
pnpm daemon init-labels                          # creates fleet:* labels in each repo
pnpm daemon sync-templates                       # stamps the fleet skill + .mcp.json into each repo
```

`templates/` in this repo (the fleet-backlog skill and `.mcp.json` registration) is the source of truth for what each registered project carries; `sync-templates` copies the skill file as-is and merges only the `mcpServers.fleet` entry into each project's `.mcp.json`, leaving other servers untouched. It only writes into working trees — review the diff and commit it in each project yourself. Rerun it after pulling fleet updates that touch the templates.

## Running

```bash
pnpm daemon -- --dry-run --once   # poll and report what would be claimed; changes nothing
pnpm daemon -- --once             # one cycle: claim, run workers to completion, exit (no dashboard, so approvals auto-deny)
pnpm daemon                       # the real loop + dashboard at http://localhost:4400
pnpm typecheck                    # tsc for shared+daemon+mcp, then vue-tsc for the dashboard
pnpm test                         # vitest: daemon loop/state/github logic, worker contract guards, mcp client
```

Every `pnpm daemon` run installs dependencies and rebuilds the dashboard (via turbo, cached) before the daemon starts, so the served bundle is never stale. The daemon serves that dashboard and a REST/WS API:

- `GET /api/board` — board tickets (including a synthesized Done column of recently-closed tickets), plus the daemon's pause state and running count.
- `POST /api/daemon/pause` — `{ paused: boolean }`; toggles drain mode (below).
- `POST /api/daemon/shutdown` — `{ mode: "drain" | "now" }`; stops the long-running daemon (below). 409s if a shutdown is already in progress.
- `GET /api/tickets/:project/:issue` — a ticket's record plus a journal tail.
- `POST /api/tickets/:project/:issue/priority`, `POST /api/tickets/:project/:issue/restart`, `POST /api/tickets/:project/:issue/reply` — dashboard actions (reprioritize, force-restart, steer or resume a session).
- `POST /api/projects/:project/tickets` — file a new ticket (`{ title, body, priority?, ready?, dependsOn? }`); this is what the `@fleet/mcp` server and the fleet-backlog skill call so an agent can queue follow-up work without touching `gh` directly.
- `GET /api/projects/:project/backlog` — that project's current tickets (number, title, status, priority), for dedup checks before filing.
- `GET /api/approvals`, `POST /api/approvals/:id` — the approvals inbox: tool calls outside the worker allowlist and `AskUserQuestion` park here until the dashboard answers, or `approvalTimeoutMinutes` denies them.
- `/ws` — pushes `board-updated` / `approvals-updated` events (no payload; clients refetch).

For dashboard development, `pnpm dashboard:dev` runs Vite on :4401 proxying to the daemon.

The dashboard header has a **Pause/Resume** toggle (drain mode): while paused, the daemon claims nothing new and resumes nothing — no `fleet:ready` pickups, no review-feedback resumes, no stall recovery — but sessions already running are left to finish, and board polling plus merged-ticket cleanup keep going. The pause is persisted in `.fleet/state.json`, so it survives a daemon restart and is cleared only by an explicit resume. It's the same gate the plan usage-limit pause uses, so the two can't fight each other.

Ticket detail has a **Restart** button for stuck, stalled, or failed tickets: it force-closes the session and puts the issue back in `fleet:ready`, so the next cycle re-runs it from scratch. The fresh claim recreates the branch and worktree from `origin/<defaultBranch>`, which **discards the previous session's commits** — the dashboard confirms before firing.

Stopping the long-running daemon (`--once` runs need none of this) has two modes, both guarded against firing twice:
- **Drain** (`POST /api/daemon/shutdown` with `{ "mode": "drain" }`) enables the same pause as the dashboard's Pause toggle, then exits once every running ticket reaches a normal terminal state (review/needs-input/failed) — nothing is interrupted.
- **Stop now** (`{ "mode": "now" }`, and Ctrl+C / SIGTERM) aborts every live session immediately and leaves each interrupted ticket `stalled` with its session id intact and `autoResumed` cleared, so the next `pnpm daemon` boot auto-resumes every one of them exactly once instead of burning that budget recovering from an unclean stop.

Operational state lives in `.fleet/` (ticket records in `state.json`, closed-ticket archive in `history.json`, per-ticket session journals in `journals/`). The source of truth for tickets is always GitHub.

## Filing tickets from inside a project

A registered project gets an MCP server (`@fleet/mcp`, registered via `.mcp.json`'s `fleet` entry — `sync-templates` stamps this in, pointed at this repo and the project's name) and a matching skill (`templates/fleet-backlog/SKILL.md`, stamped into `.claude/skills/fleet-backlog/`). Together they let an interactive session or another fleet worker queue follow-up work — a bug it noticed, a deferred refactor — as a real fleet ticket instead of losing it when the session ends:

- `fleet_query_backlog` — lists the project's current tickets, for a dedup check before filing.
- `fleet_file_ticket` — files a new ticket (`title`, `body`, optional `priority`, optional `ready` to file for human curation instead of immediate pickup, optional `dependsOn` issue numbers that hold it until they close).
- `fleet_board_status` — per-column counts across all projects, plus currently-running tickets and their latest activity.

All three are thin wrappers over the REST endpoints above; GitHub issues stay the single source of truth.

## Refining tickets

- **Comments are the refinement surface.** At claim time the worker's first prompt includes the issue body and every comment on it, read fresh — so adding a comment before a ticket is claimed is fully effective. Nobody needs to edit the original body for routine refinement.
- **Body edits are for genuine rescoping only** — reserve them for when the problem itself changed, not as a substitute for a comment.
- **Plan children default to not-ready.** Unless the project sets `planChildrenReady: true` (see [Epic decomposition](#epic-decomposition-fleetplan) below), a decomposed epic's child tickets are filed without `fleet:ready` — a human reviews each one and labels it ready themselves, becoming its natural owner. Tickets filed via the fleet-backlog skill work the other way: `ready` defaults to true (immediately pickable), and the filer passes `ready: false` when a ticket needs human curation first.
- **What "ready" means:** a self-contained problem statement, acceptance criteria, and verification steps — an agent with no other context could act on it without needing to ask a clarifying question first.

## Epic decomposition (`fleet:plan`)

Labeling an issue `fleet:plan` runs it as a read-only planning session instead of a coding one: the worker explores the repo for context but never writes files or commits, and its structured result is a list of self-contained, PR-sized child tickets (each with a title, body, optional priority, and an honest `light`/`standard`/`elevated` tier guess) rather than a diff. On completion, fleet files each child as its own issue — tagged with its suggested tier label and, if the project sets `planChildrenReady: true`, `fleet:ready` immediately; otherwise a human labels children ready individually. The epic issue itself goes straight to `fleet:review` with the child list in its status comment, never opens a PR, and a blocked decomposition works exactly like a blocked coding ticket (question posted, session held open for a reply).

## Review feedback and recovery

A few things happen automatically without reclaiming a ticket from `fleet:ready`:

- **Machine review.** When a code worker reports completed, a cheap read-only reviewer session (running on `lightModel` if set, else `model`) reviews the branch diff *before* anything is pushed or a PR is opened. It reports real defects only (no style nits, no test re-runs — those already ran in the worker session). Findings send the still-live worker back for exactly one fix round; then the ticket proceeds to `fleet:review` regardless, with the review outcome noted in the issue's status comment. A reviewer failure never blocks the ticket — it proceeds as if the review passed. Opt out per project with `machineReview: false`.
- **Review feedback.** Every cycle, tickets sitting in `fleet:review` are checked for changes-requested reviews or new inline comments on their PR. If there's fresh feedback (and the project hasn't set `autoAddressReviews: false`), the ticket's session resumes in its existing worktree/branch with the feedback as its next message; a watermark (`lastReviewHandledAt`) keeps the same feedback from being reprocessed.
- **Stall recovery.** A ticket with no activity for `stalledAfterMinutes` (or orphaned by a daemon restart) is flagged `stalled` and then auto-resumed from its last session, once. A second stall on the same ticket is left for a human to look at.
- **Auto-elevate on failure.** A run that fails outright (not `blocked`) auto-retries once on the project's `elevatedModel`, if one is configured and `autoElevateOnFailure` isn't set to `false`. A second failure — now already elevated — falls through to `fleet:needs-input` normally.
- **Plan usage-limit pause.** If a session's own error text indicates the account's plan usage limit was hit, the whole daemon pauses (no new claims or resumes, across every project) until the parsed reset time plus `limitResumeSlackMinutes`, or `limitDefaultBackoffMinutes` if no reset time could be parsed out of the message. The ticket that hit the limit is left `stalled` so it resumes automatically once the pause lifts.

## Config

See `fleet.config.example.json`. Top level: `worktreeRoot`, `pollIntervalSeconds`, `dashboardPort` (default 4400), `dataDir` (default `.fleet`), `claudeExecutable` (optional, overrides which Claude CLI binary workers run), `stalledAfterMinutes`, `ticketTimeoutMinutes` (per-turn timeout), `approvalTimeoutMinutes` (how long an approval or `AskUserQuestion` waits before auto-denying), `replyWaitMinutes` (how long a blocked ticket holds its session open for a dashboard reply before closing it resumable), and `limitResumeSlackMinutes`/`limitDefaultBackoffMinutes` (plan usage-limit pause tuning, above).

`windowBudgetUsd` (optional, unset by default) turns on a rolling-window spend gate over new claims: fleet sums its own spend ledger (every recorded cost delta, timestamped) over the trailing `usageWindowHours` (default 5, mirroring the plan's own rolling window), and once that sum passes `budgetLightThreshold` (default `0.85`) of `windowBudgetUsd` it claims only `fleet:light`-labeled issues, and once it reaches `windowBudgetUsd` it claims nothing until spend ages out of the window. This only gates new claims — resumes and already-live sessions are never held back, and the reactive plan usage-limit pause above remains the hard backstop. It's a self-estimate, not a guarantee: interactive Claude use on the same plan is invisible to fleet, so treat it as a governor rather than a hard ceiling.

Per project: `repoPath` (local clone), `githubRepo` (`owner/repo`), `defaultBranch`, `maxConcurrent`, `maxInReview` (default 3 — claiming holds once this many issues are labeled `fleet:review`, so the review queue can't outpace a human reviewer), optional `setupCommand` (run in each fresh worktree, e.g. `pnpm install` — ignored when the target repo declares its own `fleet.yaml`, below), optional `model`/`elevatedModel`/`lightModel` and `allowedTools` overrides, `planChildrenReady` (default off — file `fleet:plan` children straight into `fleet:ready`), `autoElevateOnFailure` (default on), `autoAddressReviews` (default on), and `machineReview` (default on — pre-review every completed code ticket with a cheap model before human review).

## Worktree provisioning: `fleet.yaml`

A target repo can self-describe its own setup instead of the fleet operator encoding it in `setupCommand`, by committing a `fleet.yaml` to its root:

```yaml
# Simple repo — a bare step list, run in order
setup:
  - name: install
    run: pnpm install
```

```yaml
# Monorepo — named profiles, selected per ticket
setup:
  default:
    - name: install
      run: pnpm install
  frontend:
    - name: install
      run: pnpm install
    - name: build-storybook
      run: pnpm --filter web build-storybook
  backend:
    - name: install
      run: pnpm install
    - name: test-db
      run: pnpm db:migrate:test
```

In map form a `default` profile is required; every other key becomes a selectable profile. The daemon reads `fleet.yaml` from the **fresh worktree**, after `git worktree add` and before the worker session starts — provisioning stays fully deterministic and daemon-side, with no agent or model involvement.

**Profile selection** is driven by a `fleet:type:<name>` label on the issue: `fleet:type:frontend` selects the `frontend` profile. No type label, or one that names a profile the file doesn't declare, falls back to `default` (a warning is logged for the unknown case; the claim is never failed for it). Multiple type labels pick the first match in alphabetical order and log a warning about the ambiguity. `pnpm daemon init-labels` creates a `fleet:type:<name>` label for every profile a repo's `fleet.yaml` declares (skipping `default`) — per-repo, not part of the global `fleet:*` label set.

**Precedence:** `fleet.yaml` present in the worktree wins outright — `setupCommand` is ignored for that claim. No `fleet.yaml` → `setupCommand` behaves exactly as before (including being a no-op when unset). A malformed `fleet.yaml` (bad YAML, or schema-invalid — e.g. a profile map missing `default`) fails the claim with the problem named in the status comment and daemon log; it never silently falls back to `setupCommand`, since that could mask a broken spec indefinitely. A step that fails also fails the claim, naming which step failed (e.g. `setup step "build-storybook" failed: ... (exit 1)`).

## Roadmap

- ~~Phase 0: walking-skeleton daemon, no UI.~~ Done — verified end-to-end (issue → worker → PR).
- ~~Phase 1: REST/WS API, Vue dashboard (board + ticket detail).~~ Done.
- ~~Phase 2: needs-input steering, approvals inbox, worker questions answered from the dashboard.~~ Done.
- ~~Phase 3: model visibility, live activity notes, stall recovery, merged-worktree cleanup, cost totals.~~ Done.
- ~~Phase 4: test suite, ticket-intake REST API + `@fleet/mcp` backlog tool, `fleet:plan` epic decomposition, PR review-feedback loop, stall auto-resume, plan usage-limit pause, Done column.~~ Done.
- ~~Phase 5: machine review gate, operator drain mode, turborepo build pipeline, loop split into per-concern modules, broadened test coverage.~~ Done.

## Skills, agents, and models

Workers load each project's own `.claude/` setup (`settingSources: ['project']`): CLAUDE.md instructions, **skills** (`.claude/skills/`), and **subagents** (`.claude/agents/`) all work inside worker sessions, auto-triggering from their descriptions exactly like interactive Claude Code. The `Skill`/`Agent` tools are in the default worker allowlist.

Model selection is layered, most specific wins:

1. **Skills and agents in the repo** — `model:` frontmatter in a SKILL.md or agent .md pins the model for that skill/agent's work. This is the recommended place to encode "this kind of task needs this model."
2. **`fleet:elevate` label** on an issue — runs that ticket's session on the project's `elevatedModel` (config). Add the label + reply to a blocked ticket to retry harder with a stronger model. Wins over `fleet:light` if both are present.
3. **`fleet:light` label** on an issue — runs that ticket's session on the project's `lightModel` (config), for cheap mechanical work (doc tweaks, renames, small sweeps). No-op without `lightModel` configured. A `fleet:plan` decomposition can tag a child ticket's suggested tier when it judges the work light or elevated; standard tier gets no label.
4. **Per-project `model`** in the config — the session default for all of that project's workers; unset means the Claude CLI's configured default.

The model actually used shows on each board card and in ticket detail, with a per-model token/cost breakdown after each run (subagent models included).
