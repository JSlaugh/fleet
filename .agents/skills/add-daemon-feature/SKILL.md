---
name: add-daemon-feature
description: Orientation map for changing daemon behavior in packages/daemon/src — where the supervise state machine lives, which loop.*.test.ts file covers which behavior, and where a new test belongs. Use when adding or modifying daemon/loop logic, not for dashboard or mcp changes.
---

# add-daemon-feature

`packages/daemon/src` is grouped into subdirectories by concern: `loop/` (the poll loop and its supporting modules), `session/` (worker sessions, machine review, approvals), `github/` (GitHub/git shelling out), `server/` (the dashboard's REST/WS API), `store/` (on-disk state/history/journal), and a handful of root files (`index.ts`, `config.ts`, `log.ts`, `sync-templates.ts`, `notify.ts`, `throttle.ts`, `update.ts`, `restart-code.ts`). Tests are colocated with their subject module.

`loop/loop.ts` (`FleetLoop`) is only a coordinator: it owns the shared `LoopContext` (`loop/context.ts`) and hands it to plain-function modules, all also in `loop/`. Find the concern, then find its test file.

## Where behavior lives

| Module | Concern |
|---|---|
| `loop/context.ts` | `LoopContext` type; `key`/`countRunning`/`track`/`markWorking` helpers shared by everything else |
| `loop/claim.ts` | Per-project poll cycle (`cycleProject`); picking which ready issues to claim, claim-collision resolution, stale-`fleet:ready` healing, contributor-floor routing |
| `loop/intake.ts` | Issue-body intake lint on the claim path (`lintIntakeBody`/`applyIntakeLint`) — a rejected body goes straight to `fleet:needs-input`, never claimed |
| `loop/runner.ts` | Opening/resuming a worker session, model/effort selection (`selectModel`/`selectEffort`), `fleet.yaml` type contract/tier resolution, `canUseTool` |
| `loop/supervise.ts` | **The turn state machine** — `supervise()` loops on `session.nextResult()`; `completed` → `machineReviewGate` (or `planReviewGate` for plans) → `finishCompleted`/`finishPlanned`; `blocked` → `park()` (waits `replyWaitMinutes` for a dashboard reply, resumable after); anything else → `finishFailed` |
| `loop/finish.ts` | Terminal paths: completed (push+PR)/planned (file child issues)/blocked (status comment)/failed, plus `shouldAutoElevate` and failure routing (`reportRunFailure`) |
| `loop/pause.ts` | Plan usage-limit pause (`handlePlanLimit`, `extendPause`) plus operator drain and per-project pause gates (`isPaused`/`isProjectPaused`) |
| `loop/budget.ts` | Rolling spend-window budget gate over new claims (`computeBudgetGate`, `recordSpend`) |
| `loop/workHoursReserve.ts` | Pre-work-hours claim reserve: holds claims in the window before configured work start |
| `loop/recovery.ts` | Stall detection (`flagStalled`) + picking tickets to auto-resume (`pickAutoResumable`) |
| `loop/reviews.ts` | Resuming `fleet:review` tickets on changes-requested/new comments/merge conflicts |
| `loop/comments.ts` | Issue-comment steering of `running`/`needs-input` tickets (`pickCommentCandidates`/`addressComments`) |
| `loop/automerge.ts` | Auto-merging `fleet:review` PRs that are approved and green-checked, for opted-in projects |
| `loop/epics.ts` | Closing an epic once all its filed children are closed (`epicCloseDecision`/`closeFinishedEpics`) |
| `loop/heartbeat.ts` | Status-comment claim heartbeats + releasing stale claims from a dead daemon |
| `loop/digest.ts` | Periodic activity digest: compute, schedule, and send via `notify.ts` |
| `loop/postmortem.ts` | Failure post-mortem for status comments (journal tail + commit log summary) |
| `session/review.ts` | The machine-review/plan-review reviewer session itself (prompt building, running it, verdict parsing) |
| `loop/board.ts` | Board projection for the dashboard + finished-ticket cleanup (`cleanupFinished`) |
| `loop/pin.ts` | Board active/dormant project pin — display-only, distinct from pausing |
| `loop/operator.ts` | Dashboard-triggered reply/restart, `resetForFreshClaim` |
| `loop/shutdown.ts` | Stop-now: sweeping abort of live sessions during the drain window |

## Test file map (`loop/*.test.ts`)

Each file tests exported functions imported from their real module (not `loop.ts`) — `loop.ts` itself has no dedicated test file since it's just wiring. All live in `loop/` alongside the modules they cover.

- `loop.deps.test.ts` — `selectEligibleReady` + `resolveClaimCollision` (claim.ts): label/dependency/in-flight filtering, assignee routing
- `loop.claim.test.ts` — `cycleProject` wiring (backpressure, budget/work-hours/contributor-floor gates), `healStaleReadyLabels`, `processTicket`, `selectCollaboratorAuthored` (claim.ts)
- `loop.intake.test.ts` — `lintIntakeBody` + `applyIntakeLint` (intake.ts)
- `loop.model.test.ts` — `selectModel` + `selectEffort` (runner.ts): label → model/effort tier resolution
- `loop.typecontract.test.ts` — `resolveTypeContract` + `resolveTypeTier` (runner.ts): `fleet.yaml` type lookups
- `loop.canusetool.test.ts` — `makeCanUseTool` (runner.ts): approval routing, `--once` auto-deny
- `loop.supervise.test.ts` — `resolveTimeoutMinutes` (supervise.ts)
- `loop.machinereview.test.ts` — `machineReviewGate` + `planReviewGate` (supervise.ts): pass/findings/one-attempt cap/fail-open; plus `machineReviewLine` (finish.ts) and `resetForFreshClaim` (operator.ts)
- `finish.test.ts` — `finishCompleted`/`finishBlocked` status-comment error policy, post-completion pipeline failures, `resolveDependsOnIndex` + `finishPlanned` dependsOn translation (finish.ts)
- `loop.escalate.test.ts` — `shouldAutoElevate`, `finishFailed` auto-escalation, `reportRunFailure` (finish.ts)
- `loop.planlimit.test.ts` — `handlePlanLimit` pause duration math + `isPaused`/`updatePauseState` (pause.ts)
- `loop.pause.test.ts` — `FleetLoop.cycle` under operator drain mode and per-project pause (pause.ts gate, `pausedProjectNames` in board.ts)
- `loop.budget.test.ts` — `computeBudgetGate`, `budgetStatus`, `recordSpend` (budget.ts)
- `loop.workhours.test.ts` — `computeWorkHoursReserveWindow`/`computeWorkHoursReserveGate`/`workHoursReserveStatus` (workHoursReserve.ts)
- `loop.autoresume.test.ts` — `pickAutoResumable` + `flagStalled` (recovery.ts): stall auto-resume selection
- `loop.reviews.test.ts` — `pickReviewCandidates`, `shouldActOnFeedback`, `shouldResumeForConflict`, `shouldClearConflictGuard` (reviews.ts)
- `loop.conflict.test.ts` — conflict detection in `addressReviews` (reviews.ts)
- `loop.comments.test.ts` — `pickCommentCandidates`, `buildCommentPrompt`, `addressComments` across live/parked/cold-resume sessions (comments.ts)
- `loop.automerge.test.ts` — `pickAutoMergeCandidates`, `latestReviewByAuthor`, `isApprovedForMerge`, `checksAreGreen`, `isMergeReady`, `autoMergeReady` (automerge.ts)
- `epics.test.ts` — `epicCloseDecision` + `closeFinishedEpics` (epics.ts)
- `loop.heartbeat.test.ts` — `isClaimStale`, `heartbeatRefreshAgeMs`, `releaseStaleClaims`, `refreshOwnHeartbeats`, `refreshStalledHeartbeatsOnBoot` (heartbeat.ts)
- `digest.test.ts` — `computeDigest`, `resolveDigestTime`, `shouldSendDigest`, `getDigest`, `checkDigestSchedule` (digest.ts)
- `loop.postmortem.test.ts` — `buildFailurePostMortem` + `gatherFailurePostMortem` (postmortem.ts)
- `loop.cleanup.test.ts` — `cleanupFinished` (board.ts): worktree/branch/state cleanup after merge+close
- `loop.done.test.ts` — `synthesizeDoneTickets` (board.ts): Done column projection
- `loop.restart.test.ts` — `restartTicket` (operator.ts): force re-queue, with and without a live session
- `loop.shutdown.test.ts` — `beginShutdown`/`shutdownDrain`/`shutdownNow` (loop.ts + shutdown.ts)
- `loop.shutdown-race.test.ts` — `cycleProject`/`recoverStalled`/`addressReviews` racing a live shutdown (`isShuttingDown` checks)

## Adding a new test

Match the existing function to a module above; if it's genuinely new behavior in that module, add cases to that module's existing `loop.*.test.ts` file rather than creating a new one. Only create a new `loop.<name>.test.ts` for a new exported function with no natural home above. Build fixtures from the shared factories in `src/test-support.ts` (`makeProject`/`makeFleetConfig`/`makeRecord`/`makeIssue`/`makeCtx`/`makeTempState`) — never hand-roll full config/record/context literals; [[write-tests]] has the conventions.

Run `pnpm test` and, since daemon logic is exactly what unit tests mock around, [[verify]]'s `pnpm daemon -- --dry-run --once` step before calling it done.
