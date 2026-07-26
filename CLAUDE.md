# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fleet is a multi-project Claude Code backlog orchestrator: a daemon polls GitHub repos for issues labeled `fleet:ready`, runs each one as a Claude Agent SDK worker session in its own git worktree, and ends every ticket at a PR for human review. A Vue dashboard (served by the daemon) shows the board and handles approvals/questions.

## Commands

```bash
pnpm install
pnpm typecheck                  # tsc for shared+daemon, then vue-tsc for dashboard
pnpm daemon -- --dry-run --once # poll and report; changes nothing
pnpm daemon -- --once           # one full cycle, then exit
pnpm daemon                     # real loop + dashboard on :4400
pnpm daemon init-labels         # create fleet:* labels in each configured repo
pnpm dashboard:dev              # Vite on :4401, proxying /api and /ws to :4400
pnpm dashboard:build            # required once for the daemon to serve the dashboard
```

There are no tests. Verification is `pnpm typecheck` plus a `--dry-run --once` daemon run. The daemon shells out to `gh` for all GitHub access, so `gh auth login` must have been run. Runtime config is `fleet.config.json` (gitignored — when changing the config shape, update both `fleet.config.example.json` and the schema in `packages/shared/src/index.ts`).

## Architecture

pnpm workspace, three packages, no build step for backend code:

- **`packages/shared`** — single-file package (`src/index.ts`) holding everything both sides need: zod config schemas, the `WorkerResultSchema` structured-output contract, label constants, `TicketRecord`/`BoardTicket`/approval types. Consumed directly as TypeScript source (root tsconfig `paths` + `allowImportingTsExtensions`; imports use explicit `.ts` extensions).
- **`packages/daemon`** — Node daemon run via `tsx` (never compiled). Hono REST + WebSocket server, Claude Agent SDK sessions.
- **`packages/dashboard`** — Vue 3 + Tailwind 4 + Vite SPA. Polls `/api/board` and listens on `/ws` for `board-updated` / `approvals-updated` pings (the WS carries no payloads; clients refetch).

### Daemon flow (the part that spans files)

`index.ts` wires everything and owns the poll loop. Each cycle, `FleetLoop` (`loop.ts`) lists `fleet:*` issues per project via `github.ts`, claims ready ones up to `maxConcurrent`, and for each: swaps labels, creates a worktree + `fleet/<issue>` branch (`worktree.ts`), records a `TicketRecord` (`state.ts`), and runs a `WorkerSession` (`worker.ts`).

`WorkerSession` wraps one Agent SDK `query()` with a streaming input queue so the supervisor can inject follow-up messages into a live session. Workers run with `permissionMode: "acceptEdits"`, `settingSources: ["project"]` (so the *target repo's* `.claude/` skills, agents, and CLAUDE.md load inside worker sessions), and a JSON-schema `outputFormat` — every turn must end in a `WorkerResult` (`completed` | `blocked`).

The supervision loop in `FleetLoop.supervise` is the core state machine: `completed` → verify commits exist, push, open PR (`fleet:review`); `blocked` → post the question to the issue's status comment (`fleet:needs-input`), then hold the session open for `replyWaitMinutes` awaiting a dashboard reply — a reply steers the live session; after timeout the session closes but stays resumable via `resume: sessionId`. `FleetLoop.reply` handles all three cases (waiting session, live session, cold resume).

Tool calls outside the allowlist and `AskUserQuestion` route through `canUseTool` → `ApprovalManager` (`approvals.ts`), which parks the promise until the dashboard answers via `POST /api/approvals/:id` or the timeout denies it. Denial messages are crafted to push the worker toward finishing as `blocked` rather than dying.

### State model — key invariant

GitHub labels are the source of truth for ticket status; `.fleet/state.json` (`StateStore`) is operational cache only (worktree paths, session IDs, cost, model usage), and `.fleet/journals/<project>/<issue>.jsonl` (`Journal`) holds summarized session transcripts for the dashboard. On boot, `StateStore.clearLiveFlags()` reconciles orphaned `running` tickets to `stalled` since no sessions survive a restart. Cleanup (worktree + branch removal) only happens once the PR is merged/closed *and* the issue is closed.

Model selection is layered (most specific wins): skill/agent `model:` frontmatter in the target repo → `fleet:elevate` label (uses project `elevatedModel`) → per-project `model` config → CLI default.

## Conventions

- ESM everywhere, Node built-ins imported as `node:*`, relative imports carry `.ts` extensions.
- All GitHub mutations go through `github.ts` helpers (which use `run()` from `exec.ts` to shell out to `gh`); don't call `gh` directly elsewhere.
- Status is reported to GitHub as a single continuously-updated status comment per issue (`upsertStatusComment`), not a stream of new comments.
- This daemon is developed and run on Windows; config paths use forward slashes (see `fleet.config.example.json`).
