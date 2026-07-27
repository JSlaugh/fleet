# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fleet is a multi-project Claude Code backlog orchestrator: a daemon polls GitHub repos for issues labeled `fleet:ready`, runs each one as a Claude Agent SDK worker session in its own git worktree, and ends every ticket at a PR for human review. A Vue dashboard (served by the daemon) shows the board and handles approvals/questions.

## Commands

```bash
pnpm install
pnpm typecheck                  # tsc for shared+daemon+mcp, then vue-tsc for dashboard
pnpm test                       # vitest for shared+daemon+mcp
pnpm build                      # turbo run build (currently just the dashboard)
pnpm daemon -- --dry-run --once # poll and report; changes nothing
pnpm daemon -- --once           # one full cycle, then exit (no dashboard server: worker approvals can only time out)
pnpm mcp                        # run the stdio MCP server directly (normally launched by a repo's .mcp.json)
pnpm daemon                     # real loop + dashboard on :4400
pnpm daemon init-labels         # create fleet:* labels in each configured repo
pnpm daemon sync-templates      # stamp the fleet-backlog skill + .mcp.json into each configured repo
pnpm dashboard:dev              # Vite on :4401, proxying /api and /ws to :4400
pnpm dashboard:build            # turbo-cached dashboard build (every `pnpm daemon` run does this first)
```

Task running is turborepo (`turbo.json`): `build` is cached with `dist/**` as its output, and `@fleet/daemon#start` declares `@fleet/dashboard#build` as a dependency, so `pnpm daemon` always installs and rebuilds the dashboard before the daemon boots — the daemon serves `packages/dashboard/dist` off disk, so a stale build there silently ships old UI. Arguments still pass through (`pnpm daemon -- --once`, `pnpm daemon init-labels`); the daemon filters the `--` that turbo forwards verbatim.

Verification is `pnpm typecheck` plus `pnpm test`, plus a `--dry-run --once` daemon run for anything that isn't unit-tested. The daemon shells out to `gh` for all GitHub access, so `gh auth login` must have been run. Runtime config is `fleet.config.json` (gitignored — when changing the config shape, update both `fleet.config.example.json` and the schema in `packages/shared/src/index.ts`).

## Architecture

pnpm workspace, four packages, no build step for backend code:

- **`packages/shared`** — single-file package (`src/index.ts`) holding everything both sides need: zod config schemas, the `WorkerResultSchema`/`PlanResultSchema` structured-output contracts, label constants, `TicketRecord`/`BoardTicket`/`ClosedTicketRecord`/approval types. Consumed directly as TypeScript source (root tsconfig `paths` + `allowImportingTsExtensions`; imports use explicit `.ts` extensions).
- **`packages/daemon`** — Node daemon run via `tsx` (never compiled). Hono REST + WebSocket server, Claude Agent SDK sessions.
- **`packages/mcp`** — tiny stdio MCP server (`@modelcontextprotocol/sdk`) exposing `fleet_file_ticket` / `fleet_query_backlog` / `fleet_board_status` as thin wrappers over the daemon's REST API. A registered project's `.mcp.json` launches it with `FLEET_PROJECT` set to that project's name (`templates/mcp.json.example` is the template; `sync-templates` stamps the merged entry in, alongside the `fleet-backlog` skill from `templates/fleet-backlog/SKILL.md`).
- **`packages/dashboard`** — Vue 3 + Tailwind 4 + Vite SPA. Polls `/api/board` and listens on `/ws` for `board-updated` / `approvals-updated` pings (the WS carries no payloads; clients refetch).

### Daemon flow (the part that spans files)

`index.ts` wires everything and owns the poll loop. Each cycle, `FleetLoop` (`loop.ts`) lists `fleet:*` issues per project via `github.ts`, claims ready ones up to `maxConcurrent`, and for each: swaps labels, creates a worktree + `fleet/<issue>` branch (`worktree.ts`), records a `TicketRecord` (`state.ts`), and runs a `WorkerSession` (`worker.ts`).

`FleetLoop` itself is only a coordinator: it owns the shared mutable state (the in-flight/live-session/reply-waiter maps, the board cache, the stores) and hands it to every other module as a `LoopContext` (`context.ts`, which also holds the `key`/`countRunning`/`track`/`markWorking` helpers they all share). The concerns live in their own files as plain functions taking that context first: `claim.ts` (per-project cycle + claiming), `runner.ts` (opening/resuming a session, model selection, `canUseTool`), `supervise.ts` (the turn state machine + machine-review gate), `finish.ts` (the completed/planned/blocked/failed terminal paths), `pause.ts` (plan usage-limit pause), `recovery.ts` (stall flagging + auto-resume), `reviews.ts` (PR-feedback resumption), `board.ts` (board projection + finished-ticket cleanup), and `operator.ts` (dashboard reply/restart). Anything a module needs from another it imports directly; nothing calls back into `FleetLoop`.

`WorkerSession` wraps one Agent SDK `query()` with a streaming input queue so the supervisor can inject follow-up messages into a live session. Workers run with `permissionMode: "acceptEdits"`, `settingSources: ["project"]` (so the *target repo's* `.claude/` skills, agents, and CLAUDE.md load inside worker sessions), and a JSON-schema `outputFormat` — every code turn must end in a `WorkerResult` (`completed` | `blocked`). A `fleet:plan` issue runs the same machinery as `kind: "plan"` instead: its `outputFormat` is `PlanResult` (a list of child ticket titles/bodies/priority/tier) and a `PreToolUse` hook denies `git commit` on top of the push/PR/label restriction below, since a planner must stay read-only. Independent of `kind`, that same hook (`denyForbiddenBash`/`denyForbiddenPlanBash` in `worker.ts`) mechanically denies `git push`, `gh pr` (except read-only `view`/`diff`), `gh issue edit|close|comment`, and `gh label` over plain Bash — allowlisted tools bypass `canUseTool`, so the "orchestrator owns pushing/PRs/labels" half of the worker contract has no other enforcement point.

The supervision loop in `supervise()` (`supervise.ts`) is the core state machine: `completed` → machine review gate → verify commits exist, push, open PR (`fleet:review`). The machine review (`review.ts`, on by default, opt out per-project with `machineReview: false`) runs a one-shot read-only session on `lightModel ?? model` over the local branch diff *before* anything is pushed; findings steer the still-live worker session through exactly one fix round (`TicketRecord.machineReviewOutcome` is the once-per-ticket cap), and any reviewer failure fails open to human review. A completed **plan** skips the gate and instead files each proposed ticket as a child issue (tagged with its suggested tier label, and `fleet:ready` immediately if `planChildrenReady`) and puts the epic straight into `fleet:review` without a PR. `blocked` (either kind) → post the question to the issue's status comment (`fleet:needs-input`), then hold the session open for `replyWaitMinutes` awaiting a dashboard reply — a reply steers the live session; after timeout the session closes but stays resumable via `resume: sessionId`. `reply()` (`operator.ts`) handles all three cases (waiting session, live session, cold resume). A run that errors outright (not `blocked`) auto-retries once on `elevatedModel` when `shouldAutoElevate` allows it (project opts in via `autoElevateOnFailure`, default on, and this ticket hasn't already been elevated), before falling back to `fleet:needs-input`.

Outside the claim loop, each cycle also: resumes stalled tickets (`pickAutoResumable` — no activity for `stalledAfterMinutes`, or orphaned by a restart — resumed once each from their last session) and resumes tickets in `fleet:review` that picked up changes-requested reviews or fresh inline comments (`pickReviewCandidates`/`addressReviews`, opt out per-project with `autoAddressReviews: false`; a `lastReviewHandledAt` watermark stops the same feedback firing twice). A session hitting the account's plan usage limit pauses claims/resumes across every project (`FleetState.pausedUntil`) until the parsed reset time (plus `limitResumeSlackMinutes`, or `limitDefaultBackoffMinutes` if no reset time parsed) — the triggering ticket is left `stalled` so the auto-resume above picks it back up once the pause lifts.

Tool calls outside the allowlist and `AskUserQuestion` route through `canUseTool` → `ApprovalManager` (`approvals.ts`), which parks the promise until the dashboard answers via `POST /api/approvals/:id` or the timeout denies it. Denial messages are crafted to push the worker toward finishing as `blocked` rather than dying.

### State model — key invariant

GitHub labels are the source of truth for ticket status; `.fleet/state.json` (`StateStore`) is operational cache only — per-ticket (worktree paths, session IDs, cost, model usage, and the `lastReviewHandledAt`/`autoElevated`/`isPlan` fields the behavior above depends on) plus one daemon-wide field, `pausedUntil`, for the plan usage-limit pause — and `.fleet/journals/<project>/<issue>.jsonl` (`Journal`) holds summarized session transcripts for the dashboard. On boot, `StateStore.clearLiveFlags()` reconciles orphaned `running` tickets to `stalled` since no sessions survive a restart. Cleanup (worktree + branch removal) only happens once the PR is merged/closed *and* the issue is closed, at which point the ticket's record moves from `state.json` into `.fleet/history.json` (`HistoryStore`, capped at 50) so the dashboard's Done column can still show it.

Model selection is layered (most specific wins): skill/agent `model:` frontmatter in the target repo → `fleet:elevate` label (uses project `elevatedModel`) or `fleet:light` label (uses project `lightModel`) → per-project `model` config → CLI default. Plan decompositions can suggest a tier per child ticket, which becomes one of these labels on the filed issue.

## Conventions

- ESM everywhere, Node built-ins imported as `node:*`, relative imports carry `.ts` extensions.
- All GitHub mutations go through `github.ts` helpers (which use `run()` from `exec.ts` to shell out to `gh`); don't call `gh` directly elsewhere.
- Status is reported to GitHub as a single continuously-updated status comment per issue (`upsertStatusComment`), not a stream of new comments.
- This daemon is developed and run on Windows; config paths use forward slashes (see `fleet.config.example.json`).
