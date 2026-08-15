---
name: add-daemon-feature
description: Orientation map for changing daemon behavior in packages/daemon/src — where the supervise state machine lives, which loop.*.test.ts file covers which behavior, and where a new test belongs. Use when adding or modifying daemon/loop logic, not for dashboard or mcp changes.
---

# add-daemon-feature

`packages/daemon/src` is grouped into subdirectories by concern: `loop/` (the poll loop and its supporting modules), `session/` (worker sessions, machine review, approvals), `github/` (GitHub/git shelling out), `server/` (the dashboard's REST/WS API), `store/` (on-disk state/history/journal), and a handful of root files (`index.ts`, `config.ts`, `log.ts`, `sync-templates.ts`, `throttle.ts`). Tests are colocated with their subject module.

`loop/loop.ts` (`FleetLoop`) is only a coordinator: it owns the shared `LoopContext` (`loop/context.ts`) and hands it to plain-function modules, all also in `loop/`. Find the concern, then find its test file.

## Where behavior lives

| Module | Concern |
|---|---|
| `loop/context.ts` | `LoopContext` type; `key`/`countRunning`/`track`/`markWorking` helpers shared by everything else |
| `loop/claim.ts` | Per-project poll cycle; picking which ready issues to claim |
| `loop/runner.ts` | Opening/resuming a worker session, model selection, `canUseTool` |
| `loop/supervise.ts` | **The turn state machine** — `supervise()` loops on `session.nextResult()`; `completed` → `machineReviewGate` → `finishCompleted`; `blocked` → `park()` (waits `replyWaitMinutes` for a dashboard reply, resumable after); anything else → `finishFailed` |
| `loop/finish.ts` | Terminal paths: completed (push+PR)/planned (file child issues)/blocked (status comment)/failed |
| `loop/pause.ts` | Plan usage-limit pause (`handlePlanLimit`, `extendPause`) — daemon-wide, gates claims/resumes |
| `loop/recovery.ts` | Stall detection + picking tickets to auto-resume |
| `loop/reviews.ts` | Resuming `fleet:review` tickets on changes-requested/new comments/merge conflicts |
| `session/review.ts` | The machine-review reviewer session itself (prompt building, running it, verdict parsing) |
| `loop/board.ts` | Board projection for the dashboard + finished-ticket cleanup (`cleanupFinished`) |
| `loop/operator.ts` | Dashboard-triggered reply/restart |

## Test file map (`loop/loop.*.test.ts`)

Each file tests one exported function, imported from its real module (not `loop.ts`) — `loop.ts` itself has no dedicated test file since it's just wiring. All live in `loop/` alongside the modules they cover.

- `loop.deps.test.ts` — `selectEligibleReady` (claim.ts): label/dependency/in-flight filtering
- `loop.model.test.ts` — `selectModel` (runner.ts): label → model tier resolution
- `loop.canusetool.test.ts` — `makeCanUseTool` (runner.ts): approval routing, `--once` auto-deny
- `loop.machinereview.test.ts` — `machineReviewGate` (supervise.ts): pass/findings/one-attempt cap/fail-open
- `loop.escalate.test.ts` — `shouldAutoElevate` (finish.ts): auto-elevate-on-failure eligibility
- `loop.planlimit.test.ts` — `handlePlanLimit` (pause.ts): pause duration math
- `loop.pause.test.ts` — `FleetLoop.cycle` under operator drain mode (pause.ts gate)
- `loop.autoresume.test.ts` — `pickAutoResumable` (recovery.ts): stall auto-resume selection
- `loop.reviews.test.ts` — `pickReviewCandidates` (reviews.ts): review-feedback resume selection
- `loop.conflict.test.ts` — conflict detection in `addressReviews` (reviews.ts)
- `loop.cleanup.test.ts` — `cleanupFinished` (board.ts): worktree/branch/state cleanup after merge+close
- `loop.done.test.ts` — `synthesizeDoneTickets` (board.ts): Done column projection
- `loop.restart.test.ts` — `restartTicket` (operator.ts): force re-queue

## Adding a new test

Match the existing function to a module above; if it's genuinely new behavior in that module, add cases to that module's existing `loop.*.test.ts` file rather than creating a new one. Only create a new `loop.<name>.test.ts` for a new exported function with no natural home above. There's no shared context-builder helper — each test file constructs its own minimal `LoopContext`/`StateStore`/`FleetConfig` fixture inline; copy the pattern from the test file closest to your change.

Run `pnpm test` and, since daemon logic is exactly what unit tests mock around, [[verify]]'s `pnpm daemon -- --dry-run --once` step before calling it done.
