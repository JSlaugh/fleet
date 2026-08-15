---
name: config-shape-change
description: Use when adding, renaming, or removing a field on FleetConfigSchema or ProjectConfigSchema in packages/shared/src/config.ts — three places must change together or pnpm test fails.
---

# config-shape-change

`fleet.config.json` (gitignored, per-machine) is validated against these zod schemas in `packages/shared/src/config.ts`:

- `FleetConfigSchema` — top-level daemon config (e.g. `pollIntervalSeconds`, `stalledAfterMinutes`).
- `ProjectConfigSchema` — per-project config, under `projects: []` (e.g. `maxConcurrent`, `machineReview`).

## Update all three together

1. **The schema** — `packages/shared/src/config.ts`. Add the field to `ProjectConfigSchema` (per-project) or `FleetConfigSchema` (top-level), with a `.default(...)` if it should be optional, or document why it's required.
2. **`fleet.config.example.json`** (repo root) — add the field with a realistic example value, at the matching level (top-level, or inside the one entry in `projects: []`).
3. **`README.md`** — the `## Config` section lists every top-level and per-project field in prose, grouped by what it controls. Add the new field to the relevant sentence/list.

## Why all three

`packages/shared/src/example-config.test.ts` parses `fleet.config.example.json` against both schemas and asserts **every key in `FleetConfigSchema.shape` / `ProjectConfigSchema.shape` is present** in the example file (top-level and per-project respectively). Miss step 2 and `pnpm test` fails immediately. It also checks the example file has no UTF-8 BOM.

Step 3 (README) isn't test-enforced — it's the human-facing doc, so it drifts silently if skipped. Do it anyway.

## Verify

```bash
pnpm test        # example-config.test.ts + config.test.ts
pnpm typecheck    # confirms nothing consuming the field (e.g. runner.ts model selection) is now mistyped
```

See [[verify]] for the full check sequence.
