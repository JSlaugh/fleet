# Fleet — Improvement Ideas

A reference backlog of enhancement ideas, grounded in the current codebase (August 2026).
Nothing here is committed work — it's a menu to pull from when deciding what to build next.
Ideas that pair well as `fleet:plan` epics are marked as such.

Each section notes **where the relevant code lives today** so a future ticket can be
self-contained (per the fleet-backlog skill's own rules: problem, acceptance criteria,
verification).

---

## 1. GitHub issue structure & typed tickets

Today, an issue's body is completely freeform: `buildIssuePrompt` (`packages/daemon/src/worker.ts`)
just concatenates title + body + comments into the worker's first message. The only structured
field in a body is the `Depends-on: #12` line (`parseDependsOn` in `github.ts`). The
fleet-backlog skill *prescribes* problem/acceptance-criteria/verification sections, but nothing
enforces them for human-filed issues, and workers get no signal about what kind of work a ticket is.

### 1a. Ship GitHub issue forms as fleet templates

Add `.github/ISSUE_TEMPLATE/*.yml` issue forms to `templates/` and have `sync-templates`
(`packages/daemon/src/sync-templates.ts`) stamp them into each registered repo alongside the
skill and `.mcp.json`. Issue forms render into markdown with predictable `### Heading` sections,
so the daemon can parse them mechanically later (see 1c).

A baseline `fleet-task.yml` form:

- **Problem** (required textarea)
- **Acceptance criteria** (required textarea, checklist-encouraged)
- **Verification** (required textarea — commands to run)
- **Depends on** (optional input — issue numbers)
- **Priority** (dropdown → auto-applies `fleet:p1/p2/p3`)
- **Model tier** (dropdown → auto-applies `fleet:light`/`fleet:elevate`/none)

Issue forms can auto-apply labels, so priority/tier stop being a manual second step.
Notably, a form can *not* auto-apply `fleet:ready` sensibly (you usually want to review first),
which matches the existing `ready: false` curation flow.

### 1b. Ticket types (UI vs backend vs docs vs …)

Introduce a type dimension orthogonal to status/priority/tier: `fleet:type:ui`,
`fleet:type:backend`, `fleet:type:docs`, `fleet:type:infra`, etc. Each type is an issue form
(auto-applying its label) plus per-type behavior in the daemon:

```jsonc
// per-project config sketch (ProjectConfigSchema in packages/shared/src/index.ts)
"ticketTypes": [
  {
    "name": "ui",
    "label": "fleet:type:ui",
    "model": "claude-sonnet-5",          // overrides tier defaults for this type
    "contractAppend": "Take before/after screenshots with the storybook skill…",
    "verifyCommands": ["pnpm test", "pnpm storybook:screenshot"],
    "reviewChecklist": ["dark-mode", "responsive", "a11y"]
  },
  {
    "name": "backend",
    "label": "fleet:type:backend",
    "verifyCommands": ["pnpm test", "pnpm typecheck"],
    "reviewChecklist": ["error-paths", "concurrency", "migration-safety"]
  }
]
```

What a type could drive, in rough order of value:

1. **Worker contract appendix** — `WORKER_CONTRACT` in `worker.ts` is one string constant for
   every ticket; a type-specific paragraph ("for UI work, verify in Storybook and attach
   screenshots to the PR body") is the cheapest way to specialize behavior.
2. **Machine-review checklist** — `review.ts`'s reviewer contract could take the type's
   checklist, so UI diffs get reviewed for a11y/responsiveness and backend diffs for error
   handling, instead of one generic "find real defects" pass.
3. **Model selection** — a fourth layer in the existing model-selection stack
   (skill frontmatter → elevate/light label → project model → CLI default).
4. **Verification expectations** — named commands the worker is told to run before
   declaring completion, and that the machine reviewer can check were actually run
   (the journal already records tool calls per session).
5. **Allowed-tools deltas** — e.g. UI type gets Playwright/browser tools, docs type
   gets a narrower list.

Type labels would need adding to `ALL_FLEET_LABELS` (shared) so `init-labels` creates them —
but see 1d for making the label set per-repo.

### 1c. Intake linting / triage gate

Before claiming a `fleet:ready` issue, validate its body. Two tiers:

- **Deterministic**: required sections present (parse the `### Heading` structure issue forms
  emit; fall back to "non-empty body" for freeform issues). Cheap, runs in `selectEligibleReady`
  (`claim.ts`) or just before `processTicket`.
- **LLM triage (optional, per-project opt-in)**: a one-shot `lightModel` session grades the
  ticket ("could an agent with no other context act on this?") — same shape as the existing
  machine-review gate, but at intake instead of completion.

A failing ticket doesn't get claimed; it gets a status comment saying what's missing and either
keeps `fleet:ready` with a `fleet:triage` marker or swaps to `fleet:needs-input`. This directly
attacks the most expensive failure mode fleet has: burning a whole worker session (and possibly
an auto-elevated retry) on a ticket that was never actionable.

### 1d. Per-repo template & label customization

`sync-templates` currently stamps identical content into every repo, and the label set is a
global constant. Two-layer approach:

- **Fleet base layer** — `templates/` as today: the skill, `.mcp.json` entry, base issue forms.
- **Repo overlay** — either a per-project directory in fleet (`templates/overrides/<project>/`)
  or, better, a directory *in the target repo* (`.github/fleet/`) that the repo owns outright:
  extra issue forms, extra ticket types, contract appendices. The daemon reads the overlay from
  the target repo's working tree at claim time, so a UI-heavy repo can define `fleet:type:ui`
  and a CLI repo never sees it.

The in-repo overlay is the stronger design: repos self-describe, template changes ride the
repo's own PR review, and `sync-templates` stays a bootstrap tool rather than a sync loop.
It also matches the existing precedent — workers already load the target repo's `.claude/`
skills and CLAUDE.md via `settingSources: ["project"]`, so "the repo customizes its own fleet
behavior" is a pattern the codebase has, not a new invention.

### 1e. Richer structured body fields

`Depends-on:` proves the pattern of machine-readable lines in a freeform body. Candidates,
all parsed with the same tolerant single-line style as `parseDependsOn`:

- `Verify: pnpm test && pnpm typecheck` — per-ticket verification override, appended to the
  worker's prompt and checkable by the machine reviewer.
- `Touches: packages/dashboard` — hints for conflict avoidance (don't run two tickets that
  declare the same surface concurrently) and for reviewer focus.
- `Timeout: 60m` — per-ticket override of `ticketTimeoutMinutes` for known-long work.
- `Blocks: #14` — inverse dependency, resolved to `Depends-on` on the referenced issue at
  claim time (or just documented as "file it on the other issue instead").

---

## 2. Planning tickets (`fleet:plan`)

The decomposition pipeline works (planner session → `PlanResult` → `finishPlanned` files
children → epic to `fleet:review`, with dashboard accept-plan already in place), but children
are filed flat and the epic relationship is only prose in a status comment.

### 2a. Sibling dependencies in plan output

`PlanResultSchema` (shared) deliberately pushes for independent tickets, but some epics
genuinely have ordering ("add the schema field" → "use it in the dashboard"). Add an optional
`dependsOnIndex: number[]` to each planned ticket (indices into `tickets[]`); `finishPlanned`
(`finish.ts`) files children in order and rewrites indices to real issue numbers as a
`Depends-on: #<n>` line in the child body. The existing claim-side dependency machinery then
just works — no new runtime concept, only a filing-time translation. Combined with
`planChildrenReady: true`, this makes a whole ordered epic fire-and-forget.

### 2b. First-class epic ↔ child linkage

Use GitHub's native sub-issues (or at minimum a `Part-of: #<epic>` body line + a task-list in
the epic body) instead of only listing children in the epic's status comment. Payoffs:

- The epic's GitHub page shows real progress (GitHub renders sub-issue/task-list completion).
- The daemon can auto-close the epic when all children's PRs merge and issues close —
  today the epic sits in `fleet:review` until a human remembers what it was.
- The board (`board.ts`) can group children under their epic instead of showing them as
  unrelated cards.
- A child's worker prompt can include the epic's context ("this is ticket 3 of 5 from epic
  #40") — cheap, useful framing that `buildIssuePrompt` currently can't provide.

### 2c. Recursive decomposition

Let a planned child carry `tier: "plan"` — filed with `fleet:plan` instead of a model-tier
label, so a large epic can decompose into sub-epics. Needs a depth guard (a `Part-of:` chain
length cap, e.g. 2) to prevent runaway planning.

### 2d. Plan quality gate & calibration

- **Plan review**: the machine-review gate is explicitly skipped for plans. A cheap
  symmetric gate — one `lightModel` pass over `tickets[]` asking "is each self-contained and
  PR-sized? is anything missing from the epic?" — catches the common failure (one vague
  mega-child, or a missing migration step) before children are filed.
- **Tier calibration**: `HistoryStore` already records per-ticket cost, model usage, and
  elevated/light flags. A small report ("tickets the planner tagged `light` averaged $X and
  N% needed auto-elevation") would show whether tier suggestions are honest, and its summary
  could be injected into the planner contract as calibration data.

### 2e. Re-planning

When an epic's scope changes after decomposition (children were filed, then the human edits
the epic), there's no path but manual cleanup. A `re-plan` action (dashboard button or
re-adding `fleet:plan`) could run the planner again with the *existing children listed in the
prompt*, producing a delta: new tickets to file, existing tickets to close as obsolete.

---

## 3. File structure

The layout is disciplined but two spots are visibly outgrowing themselves.

### 3a. `packages/daemon/src` is 70+ flat files

Source and tests share one directory; the `loop.*.test.ts` / `server.*.test.ts` prefix
convention is doing the job subdirectories normally do. A grouping that follows the seams the
code already has (per CLAUDE.md's own description of the concern split):

```
src/
  loop/        claim.ts runner.ts supervise.ts finish.ts pause.ts recovery.ts
               reviews.ts board.ts operator.ts shutdown.ts context.ts loop.ts
  session/     worker.ts review.ts queue.ts approvals.ts
  github/      github.ts worktree.ts exec.ts
  server/      server.ts  (split routes if it keeps growing: board, tickets,
               approvals, daemon-control)
  store/       state.ts history.ts journal.ts
  index.ts config.ts log.ts sync-templates.ts throttle.ts
```

Tests move with their subjects. This is a pure `git mv` + import-path sweep (all relative
imports carry `.ts` extensions, so it's mechanical) — a perfect `fleet:light` ticket, except
that the `add-daemon-feature` skill's file map and CLAUDE.md's architecture section must be
updated in the same PR or they silently rot.

### 3b. Split `packages/shared/src/index.ts`

One 350-line file holds config schemas, label constants, worker/plan/review contracts, board
types, history types, and journal types. Split by consumer-facing concern with `index.ts` as a
re-export barrel (so no import site changes):

```
src/
  labels.ts      FLEET_LABELS, PRIORITY_LABELS, ALL_FLEET_LABELS, boardStatusFromLabels
  config.ts      ProjectConfigSchema, FleetConfigSchema
  contracts.ts   WorkerResultSchema, PlanResultSchema, MachineReviewResultSchema
  tickets.ts     TicketRecord, TicketStatus, FleetState, ClosedTicketRecord
  board.ts       BoardTicket, BOARD_COLUMNS, history/journal/report types
  index.ts       export * from each
```

Note: the `config-shape-change` skill and `example-config.test.ts` reference this file — update
them in the same change.

### 3c. Prompts out of code

`WORKER_CONTRACT`, `PLANNER_CONTRACT` (`worker.ts`) and the reviewer contract (`review.ts`)
are string constants inside logic files. Moving them to `templates/prompts/*.md` (loaded at
startup) makes prompt iteration diffable prose instead of code edits, gives them a natural
home for the per-type appendices from 1b, and opens the door to per-project overrides without
forking the daemon.

### 3d. A place for docs

There's `README.md` + `CLAUDE.md` and nothing else. As ideas like these accumulate, a `docs/`
directory (this file is the first occupant) keeps README user-facing and CLAUDE.md
contributor-facing, with design notes/ADRs landing here.

---

## 4. Worker & session behavior

- **Global concurrency cap.** `maxConcurrent` is per-project only; N projects can run N×max
  sessions against one account's usage limit. A top-level `maxTotalConcurrent` in
  `FleetConfigSchema`, enforced in `cycleProject`'s capacity math, would let the plan-limit
  pause become rare instead of routine.
- **Cost budgets.** Per-project (or global) `dailyBudgetUsd`; the state store already tracks
  per-ticket `costUsd`, so the daemon can sum the day's spend and hold claims when exceeded —
  same gating point as `isPaused`. Surface budget state on the dashboard header next to
  Pause.
- **Per-ticket timeout override** (see 1e `Timeout:`) — `ticketTimeoutMinutes` is global; big
  refactor tickets and doc tweaks get the same 30 minutes.
- **Conflict-aware scheduling.** Two concurrent tickets touching the same files produce
  guaranteed merge pain. Cheap version: `Touches:` declarations (1e) serialize overlapping
  tickets. Fancier: diff the first ticket's branch and hold claims whose declared surface
  overlaps files already modified in an in-flight branch.
- **Draft-PR mode.** Per-project `draftPrs: true` — open PRs as drafts so CI runs but
  reviewers aren't pinged until a human promotes it. Pairs well with `maxInReview`.
- **CI feedback loop.** `reviews.ts` reacts to human reviews/comments but not to CI. Polling
  the PR's check status (`gh pr checks`) and resuming the session on failure — with the same
  once-per-episode watermark discipline as `lastReviewHandledAt`/`conflictHandled` — closes
  the loop fleet currently leaves to humans: "the PR is red."

---

## 5. Operations & observability

- **Webhook mode.** Polling every `pollIntervalSeconds` costs latency and `gh` rate budget.
  An optional webhook receiver (GitHub App or repo webhook → the existing Hono server) that
  just triggers an immediate cycle for the affected project keeps the poll loop as fallback
  and makes label → claim near-instant.
- **Notifications.** `fleet:needs-input` and blocked questions currently wait for someone to
  look at the dashboard. A per-project `notify` config (Slack webhook / ntfy / email) firing
  on needs-input, PR-opened, ticket-failed, and daemon-paused-on-limit would make the
  approvals inbox reactive. The `approvalTimeoutMinutes` auto-deny becomes much less costly
  when a human is actually pinged.
- **Metrics endpoint.** `/api/metrics` (Prometheus text format) from data already on hand:
  running/review/needs-input counts, claims and failures per cycle, cost counters,
  time-in-column. `HistoryAggregates` shows the aggregation habits already exist.
- **Journal hygiene.** `.fleet/journals/**/*.jsonl` grows without bound; history is capped at
  50 but journals for archived tickets are never pruned. Cleanup on archive (or a size cap)
  is a small `fleet:light` ticket.
- **`doctor` command.** `pnpm daemon doctor`: checks `gh auth status`, label existence per
  repo, worktree-root writability, config-vs-example drift, dangling worktrees/branches from
  crashed sessions. Most of these checks exist implicitly as runtime failures today.

---

## 6. Dashboard

- **File-a-ticket form.** `POST /api/projects/:project/tickets` exists for the MCP path, but
  the dashboard has no create-ticket UI — the one human action that still requires leaving the
  board for GitHub. A form with the 1a template sections prefilled would also nudge humans
  toward well-formed tickets.
- **Epic grouping.** Once 2b lands, group child cards under their epic with a progress bar.
- **Cost/analytics view.** The history endpoint already returns aggregates
  (mean cost, elevation rate, model totals); a small charts view over time-bucketed history
  would answer "what does fleet cost per week and where does it go" without leaving the app.
- **Live journal tail.** Ticket detail shows a journal tail on poll; streaming new entries
  over the existing `/ws` channel (an event per journal append for the currently-open ticket)
  would make watching a worker feel live rather than sampled.

---

## 7. Testing & tooling

- **End-to-end harness with a fake `gh`.** The unit suites are strong, but the full
  claim → worker → push → PR path is only verified manually (`verify` skill). A test-mode
  `gh` shim (a script on PATH that records mutations and serves canned issue lists) plus a
  stub Claude executable would let one vitest run exercise a whole ticket lifecycle,
  including label transitions and status-comment upserts.
- **CI matrix including Windows.** The daemon is developed and run on Windows, but nothing in
  the repo pins that in CI; path handling (`worktree.ts`, forward-slash config convention) is
  exactly the code that silently breaks cross-platform.
- **Config migration story.** `fleet.config.json` is hand-edited and schema changes are
  breaking. A `pnpm daemon migrate-config` (or zod-default-driven "unknown key" warnings at
  load) would soften the `config-shape-change` three-places-must-change ritual.

---

## Suggested first moves

If picking three, weighted by leverage-per-effort:

1. **Issue forms + intake linting (1a + deterministic half of 1c)** — directly raises the
   quality of every worker session's input, which multiplies through everything downstream.
2. **Sibling dependencies + epic linkage (2a + 2b)** — makes `fleet:plan` genuinely
   fire-and-forget for ordered work, the feature's obvious next step.
3. **Notifications (5)** — the cheapest fix for the biggest operational annoyance
   (blocked tickets waiting on nobody).

The file-structure splits (3a/3b) are best done as standalone `fleet:light` tickets *before*
the feature work above, since almost every idea here touches `shared/src/index.ts` and the
daemon's flat directory.
