---
name: write-tests
description: How to write and modify tests in this repo — shared fixture factories in packages/daemon/src/test-support.ts, mocking conventions, and what to assert on. Use whenever adding or changing any *.test.ts file, or reviewing test code for bloat.
---

# write-tests

The daemon suite is ~60 colocated vitest files. Two rules carry most of this skill: **build every fixture from `packages/daemon/src/test-support.ts`**, and **test extracted pure functions instead of mocking your way to deep code**.

## Fixtures: factories, never literals

`test-support.ts` exports patch-style factories whose defaults mirror the suite's long-standing conventions (project `alpha` at `acme/alpha`, issue 62 on branch `fleet/62`):

- `makeProject(patch)` / `makeFleetConfig(patch)` — config objects
- `makeRecord(patch)` — a `TicketRecord`
- `makeIssue(number, labels?, patch?)` — a `ReadyIssue` (with `url`)
- `makeTempState(prefix?)` — `{ dataDir, state }` on a fresh temp dir
- `makeCtx(patch)` — a complete `LoopContext` with real temp-dir stores, empty in-flight collections, and a `getProject` wired to its config
- `makeApprovals()` — the ApprovalManager stub
- `postJson(app, path, body)` — the server-test JSON POST boilerplate

Rules:

- **Never hand-roll a full `ProjectConfig`/`FleetConfig`/`TicketRecord`/`LoopContext` literal in a test file.** Duplicated literals make every schema change fan out across the whole suite — and worse, two concurrent PRs each passing typecheck alone have broken main's typecheck after merging, exactly because a new required field and a new hand-rolled literal crossed mid-air. With factories, a schema change is one edit in `test-support.ts`.
- **Patch only what the test cares about.** `makeProject({ maxConcurrent: 5 })` tells the reader what matters; a 12-field literal hides it.
- A file whose tests share non-default values keeps a **local wrapper over the shared factory** (see `finish.test.ts`'s `record()` — issue 7 defaults layered on `makeRecord`), not its own from-scratch literal.
- When you add a field to a config/record schema, update the factory's defaults in the same change — that *is* the fan-out killer working as intended.

## Prefer pure functions over mocks

The codebase deliberately extracts decision logic into pure functions (`shouldAutoElevate`, `pickReviewCandidates`, `shouldResumeForConflict`, `epicCloseDecision`; even the process supervisor's restart policy is extracted as `decideNextAction` in `scripts/supervisor-policy.mjs`). Test those directly — no mocks, no temp dirs, exhaustive cases are cheap. Reserve loop-level tests (a `FleetLoop` + mocked `github.ts`) for wiring: does the cycle call the right thing at the right time. If you find yourself mocking four modules to reach an if-statement, extract the if-statement instead and leave one wiring test behind.

## Mocking conventions

- Mock `../github/github.ts` **partially**, keeping the real module for everything you don't stub:
  ```ts
  vi.mock("../github/github.ts", async (importActual) => ({
    ...(await importActual<typeof import("../github/github.ts")>()),
    listFleetIssues: vi.fn(async () => []),
    swapLabel: vi.fn(async () => {}),
  }));
  const github = await import("../github/github.ts");   // typed access to the mocks
  ```
- `vi.mocked(github.swapLabel).mockClear()` in `beforeEach` (or `vi.clearAllMocks()` when the file stubs many).
- Cycle-level claim tests run the loop with `dryRun: true` so nothing real executes and no worktree/session mocks are needed — see `loop.claim.test.ts`'s `makeLoop`.

## What to assert on

- **State and mock calls first**: `state.get(...)`, `expect(github.swapLabel).toHaveBeenCalledWith(...)`. These survive log rewording.
- **Log-text assertions only at the dry-run seam** (cycle-level tests where the log *is* the observable output). Keep the matched substring short and load-bearing (`"would claim alpha#3"`), never a full sentence.
- Repetitive same-shape cases become one `it.each` table with `$name` in the title — see the `healStaleReadyLabels` negatives in `loop.claim.test.ts`. Don't force it when setups genuinely differ.

## Shape and placement

- Tests are colocated with their subject: `loop/loop.<function>.test.ts`, `server/server.<route>.test.ts`, `store/<module>.test.ts`. Add cases to the existing file for the module you changed; create a new file only for a new exported function with no home ([[add-daemon-feature]] has the full map).
- Keep each test three visual beats — arrange (factories) / act / assert — with a blank line between beats. If arrange outgrows a few lines, that's the cue for a factory patch or local wrapper, not a comment.
- Exemplars of the intended style: `loop/loop.claim.test.ts`, `loop/finish.test.ts`, `server/server.pause.test.ts`.

Before declaring done: `pnpm typecheck && pnpm test`, plus [[verify]]'s `pnpm daemon -- --dry-run --once` when daemon behavior changed.
