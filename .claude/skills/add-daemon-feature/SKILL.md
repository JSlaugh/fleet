---
name: add-daemon-feature
description: Orientation map for changing daemon behavior in packages/daemon/src — where the supervise state machine lives, which loop.*.test.ts file covers which behavior, and where a new test belongs. Use when adding or modifying daemon/loop logic, not for dashboard or mcp changes.
---

# add-daemon-feature

`loop.ts` (`FleetLoop`) is only a coordinator: it owns the shared `LoopContext` (`context.ts`) and hands it to plain-function modules. Find the concern, then find its test file.

## Where behavior lives

| Module | Concern |
|---|---|
| `context.ts` | `LoopContext` type; `key`/`countRunning`/`track`/`markWorking` helpers shared by everything else |
| `claim.ts` | Per-project poll cycle; picking which ready issues to claim |
| `runner.ts` | Opening/resuming a worker session, model selection, `canUseTool` |
| `supervise.ts` | **The turn state machine** — `supervise()` loops on `session.nextResult()`; `completed` → `machineReviewGate` → `finishCompleted`; `blocked` → `park()` (waits `replyWaitMinutes` for a dashboard reply, resumable after); anything else → `finishFailed` |
| `finish.ts` | Terminal paths: completed (push+PR)/planned (file child issues)/blocked (status comment)/failed |
| `pause.ts` | Plan usage-limit pause (`handlePlanLimit`, `extendPause`) — daemon-wide, gates claims/resumes |
| `recovery.ts` | Stall detection + picking tickets to auto-resume |
| `reviews.ts` | Resuming `fleet:review` tickets on changes-requested/new comments/merge conflicts |
| `review.ts` | The machine-review reviewer session itself (prompt building, running it, verdict parsing) |
| `board.ts` | Board projection for the dashboard + finished-ticket cleanup (`cleanupFinished`) |
| `operator.ts` | Dashboard-triggered reply/restart |

## Test file map (`loop.*.test.ts`)

Each file tests one exported function, imported from its real module (not `loop.ts`) — `loop.ts` itself has no dedicated test file since it's just wiring.

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
