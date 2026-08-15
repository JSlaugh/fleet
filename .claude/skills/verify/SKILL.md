---
name: verify
description: This repo's full verification procedure. Use before declaring any change to fleet complete, especially changes to daemon behavior (loop.ts and its concerns, worker.ts, config loading) that unit tests alone won't exercise end-to-end.
---

# verify

Three checks, in order. Don't declare a change done until they've run (or you've explained why one doesn't apply).

## 1. Typecheck

```bash
pnpm typecheck
```

Runs `tsc` for shared+daemon+mcp, then `vue-tsc` for the dashboard. Catches schema/type drift across package boundaries (e.g. `packages/shared` changes not reflected in `daemon` or `dashboard`).

## 2. Unit tests

```bash
pnpm test
```

Vitest across shared+daemon+mcp: the `loop.*.test.ts` files (see [[add-daemon-feature]] for the map), state/journal/github/worktree logic, worker contract guards, and the mcp client.

## 3. Dry-run daemon cycle

```bash
pnpm daemon -- --dry-run --once
```

**This is the step sessions skip.** It boots real config, real `gh` calls, and one live poll cycle — the only check that exercises the daemon end-to-end without unit-test mocks. Run it for anything touching `loop/loop.ts` or its concern modules (`loop/claim.ts`, `loop/runner.ts`, `loop/supervise.ts`, `loop/finish.ts`, `loop/pause.ts`, `loop/recovery.ts`, `loop/reviews.ts`, `loop/board.ts`, `loop/operator.ts`), `config.ts`, or `github/github.ts` — changes a unit test wouldn't catch because it mocks `gh` or `LoopContext` construction.

It changes nothing (no claims, no worktrees, no label writes) — safe to run anytime `fleet.config.json` exists and `gh auth login` has been run. If neither is set up in the current environment, say so explicitly instead of skipping silently — a pure-dashboard or pure-schema change may not need it.

If you touched `ProjectConfigSchema`/`FleetConfigSchema`, see [[config-shape-change]] first — `pnpm test` will fail on `example-config.test.ts` if the example file or README drifted.
