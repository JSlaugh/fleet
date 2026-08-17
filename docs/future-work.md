# Fleet — Future Work

The curated build list. Every item here survived a one-by-one review on 2026-08-16 against a
40-item candidate list drawn from `improvement-ideas.md`, `roadmap-walkthrough.md`, and
`analytics-ideas.md`; 26 candidates were rejected and are recorded at the bottom with reasons,
so they don't get re-proposed without new information.

Those three documents remain the raw menus and the record of *why* past decisions were made.
**This file is what's actually next.** Scope decisions made during the review are noted per item
— several were deliberately narrowed, and one was reshaped entirely.

---

## A. Data: store it once, then actually read it

The theme that came out of the audit: **fleet's capture problem is solved and its read-back
problem isn't.** #131 widened journal capture, #130 moved state and history into SQLite, #93
archives full transcripts — and almost nothing reads any of it back. This group closes that.

### A1. Move journal entries into `fleet.db`

*Reshaped during review — this replaces "gzip or prune journals at archive time."*

**Today:** `.fleet/journals/<project>/<issue>.jsonl` grows without bound and is never pruned or
compressed (`store/journal.ts`). Cleanup in `loop/board.ts` copies transcripts, removes the
worktree and branch, and archives the record — and leaves the journal behind untouched. #130
deliberately left journals as JSONL when everything else moved to SQLite.

**Build:** a `journal_entries` table in `.fleet/fleet.db`, with a one-time import of existing
JSONL files following the `*.imported.bak` pattern `store/db.ts` already uses for
`state.json`/`history.json`. Retention becomes a policy — a `DELETE` on an indexed column, the
way `daemon_events` already ages out at 30 days — rather than file management.

**Why this shape:** it fixes three things at once. Retention stops being bespoke file handling;
`buildTicketReport` (`server/server.ts`) stops being a JS loop over a JSONL file and becomes a
query; and the per-ticket decision events #131 records stop being stranded in per-ticket files
that nothing can aggregate across. That last point is what makes A3 cheap.

**Note:** this supersedes `analytics-ideas.md`'s "journals could stay JSONL — append-only files
are a fine fit," which was written before #131 widened entries and before the read-back gap was
visible. It also removes the need for a separate `ticket_events` table (see rejected item 31);
any ticket transition that isn't journaled today should simply be journaled as a fleet event.

### A2. Close the two remaining capture gaps

**Today:** after #131, `summarize()` (`session/worker.ts`) still drops exactly two things —
**thinking blocks** (assistant content is filtered to `text` and `tool_use` only) and
**user/steering message text** (only `tool_result` blocks are extracted, so operator steering
survives only as an `operator-message-injected` marker with no content).

**Build:** capture both.

**Decided in review:** the `journalMode: "full"` raw-SDKMessage idea was **dropped** — #93's
transcript copy already owns the full stream. The narrow version still earns its place because
it covers *live and recent* tickets, where no transcript copy exists yet.

**Sequencing:** land after A1 so the table schema carries these entry types from the start, or
fold into the same change.

### A3. Read back the decision data

**Today:** `buildTicketReport` ignores every `type: "fleet"` journal entry except `claimed` and
`resumed`; `computeHistoryAggregates` (`store/history.ts`) never touches the fields #131 added.
All of the following is recorded and unread:

- **`bash-denied` counts** — every `denyForbiddenBash` firing is journaled. A rising rate on a
  model is early warning that a worker is going off-contract.
- **Approval latency** — `waitMs` on every `approval-decided` event. This is the human-bottleneck
  number that the `approvalTimeoutMinutes` auto-deny papers over.
- **Cache economics** — per-message cache-read/cache-write tokens are captured, then discarded
  at the aggregate layer: `ModelUsageSummary` and `sumModelUsage` keep only input/output/cost.
- **Machine-review efficacy** — findings are journaled per run and the outcome sits on the
  record, but `HistoryAggregates` has no field for it, so "does the gate catch real defects or
  burn fix rounds on noise" is unanswered.

**Build:** aggregate these into the ticket report and history aggregates, and surface them.

**Depends on:** A1 makes this substantially cheaper (a `GROUP BY` instead of re-reading files).

### A4. Outcome joins at cleanup

**Today:** `ClosedTicketRecord` keeps `prState` and nothing else about the PR, so cost data has
nothing to be divided by.

**Build:** at cleanup — where `getPrState` is already called — also record **time-to-merge**,
**whether a human pushed commits to the fleet branch after the PR opened** (the best available
proxy for "the worker's output needed rework"; `gh pr view` exposes commit authors), **human
review rounds**, and **review-comment count** (`loop/reviews.ts` consumes reviews already and
counts nothing).

**Why it matters:** this is what makes *cost per cleanly merged PR, by model tier* computable —
the metric that would settle whether planner tier guesses are honest, and the one thing the
shipped storage still cannot produce.

### A5. Serve the archived transcripts

**Today:** #93 copies each session's full CLI transcript into
`.fleet/transcripts/<project>/<issue>/` at archive time, and nothing ever opens it. The only
place a transcript surfaces is the failure post-mortem comment (`loop/postmortem.ts`), which
prints the archived directory and a `claude --resume <sessionId>` command — and only on failure.

**Build:** `GET /api/tickets/:project/:issue/transcript` plus a viewer in ticket detail, and show
the resume command for every ticket rather than only failed ones.

**Trap for the implementer:** `TicketDetail.vue` already has a heading called "Session
transcript" that renders the **journal**, not the transcript.

### A6. Time-bucketed cost and analytics charts

**Today:** `HistoryView.vue` renders aggregate tiles (total/mean cost, elevation/light/plan
rates, per-model totals); nothing is bucketed over time.

**Build:** cost and outcome charts by week, project, and model tier.

**Decided in review:** explicitly sequenced **after A3 and A4** — built before them it would
only re-plot the tiles that already exist.

---

## B. Worker and ticket behavior

### B1. Quality gate on plan decompositions

**Today:** completed code tickets pass through the machine-review gate; plans skip it entirely —
`loop/supervise.ts` routes a completed plan straight to `finishPlanned`, which files every
proposed child as a real GitHub issue.

**Why now:** that was low-risk when children were filed flat and inert. #134 (`dependsOnIndex`)
and #135 (epic linkage), plus `planChildrenReady: true`, mean one planner session can now fan out
an ordered chain of tickets that start claiming themselves unattended. It is the only unguarded
path left in the system.

**Build:** one `lightModel` pass over `tickets[]` before children are filed — "is each
self-contained and PR-sized? is anything missing from the epic?" — in the same one-shot,
read-only, fail-open-to-human shape as `session/review.ts`.

### B2. Prior-attempt memory in the worker prompt

**Today:** `buildIssuePrompt` (`session/worker.ts`) is body + comments + the epic block from
#135. Meanwhile `loop/operator.ts` writes a restart summary onto the record and #108's
`loop/postmortem.ts` assembles a real failure narrative — what was attempted, where it died —
and posts it to the issue. Neither is fed back into the next session. **Fleet knows exactly why
the last attempt failed and declines to tell the next worker.**

**Build:** on restart or resume-after-failure, include the previous session's summary and failure
reason in the prompt.

**Decided in review:** deliberately scoped to this one block. The three other proposed context
blocks — recent commits and blame, precedent PRs, resolved `#refs` — were **dropped** as token
cost for uncertain gain.

### B3. `Timeout:` body field

**Today:** `ticketTimeoutMinutes` is global (`loop/supervise.ts`), so a large refactor and a doc
tweak get the same 30 minutes; long tickets die at the timeout and land in stall recovery.

**Build:** a per-ticket `Timeout: 60m` line, parsed with the same tolerant single-line style as
`Depends-on:` and `Part-of:` in `github/github.ts`.

**Decided in review:** the sibling proposals `Verify:`, `Touches:`, and `Blocks:` were
**dropped** — redundant with `fleet.yaml` and repo CLAUDE.md, or speculative.

### B4. Let `fleet:type:` labels drive behavior

**Today:** the type dimension exists and is already per-repo — #94 has `init-labels` create a
`fleet:type:<name>` label for every profile a repo's `fleet.yaml` declares — but it drives
exactly one thing: which setup profile provisions the worktree. No behavior hangs off it.

**Build (full scope, approved as such):** extend the type with

1. a **worker-contract appendix** (`WORKER_CONTRACT` in `session/worker.ts` is one string for
   every ticket today),
2. a **machine-review checklist** per type, so UI diffs get reviewed for a11y and responsiveness
   and backend diffs for error paths, instead of one generic "find real defects" pass,
3. a **model tier** per type — a new layer in the existing selection stack,
4. **verify commands** the worker is told to run and the reviewer can confirm ran.

**Key design decision:** these are declared as **sibling keys to `setup:` in the target repo's
own `fleet.yaml`** — *not* as a `ticketTypes` array in fleet's config. That extends the
"repos self-describe" precedent #94 established and keeps per-repo behavior in the repo's own
review process.

**Size:** the largest item on this list. Worth splitting — the review checklist is the piece
where a generic prompt most demonstrably underperforms a specific one.

---

## C. Dashboard

### C1. Redesign around active vs. dormant projects

**Today:** `App.vue` renders every project identically with a pause toggle bolted on. Per-project
pause (#101) shipped explicitly as "the primitive this demands" — and the layout it was meant to
enable never followed.

**Build:** active vs. dormant becomes the primary organizing distinction — dormant projects
collapse to rollup rows, active ones get the full board. This matches the real scale model: many
projects *connected*, only 1–2 *actively worked*, because token budget rather than UI is the
concurrency limit.

**Folded in — attention-first "needs me" queue:** a cross-project queue ordered by what needs a
human now — parked approvals, `fleet:needs-input` questions, failed tickets with post-mortems,
PRs awaiting review, stale-claim releases — sorted by wait time. Approved as *part of* this
redesign rather than a separate surface, on the reasoning that the attention queue is plausibly
what an active project's board should lead with.

### C2. In-board diff preview

**Today:** nothing in the dashboard fetches or renders a diff; reviewing a fleet PR always means
leaving the board.

**Build:** a read-only diff view in ticket detail, via `gh pr diff` (the machine reviewer already
reads this same data in `session/review.ts`).

**Decided in review:** scoped as a **triage** preview — enough to decide whether a PR needs real
attention. Actual reviewing stays on GitHub, where inline comments live and where fleet's
review-feedback loop (`loop/reviews.ts`) gets its input.

### C3. File-a-ticket form

**Today:** `POST /api/projects/:project/tickets` exists and backs the MCP path, but
`dashboard/src/lib/api.ts` has no create-ticket call. Filing is the one routine human action that
still requires leaving the board for GitHub.

**Build:** a form mirroring the issue-form sections (problem / acceptance criteria / verification,
plus priority and depends-on). It must satisfy the same `loop/intake.ts` lint that gates claims,
so a malformed ticket fails at the desk rather than at claim time.

---

## D. Guardrails

### D1. Warn on unknown config keys

**Today:** `daemon/src/config.ts` is a plain `safeParse` with no `.strict()`, so a misspelled key
in the hand-edited, gitignored `fleet.config.json` is silently ignored — a typo'd
`machineRevieww: false` reads as "default on" and nothing says otherwise.

**Build:** warn at load on keys the schema doesn't recognize.

**Decided in review:** the `migrate-config` subcommand half was **dropped**. Note the existing
`example-config.test.ts` enforces the schema→example link; it's the example→*your config* link
that has nothing guarding it.

---

## Suggested order

1. **A1 + A2** — the storage move, with the capture gaps folded in while the schema is in flux.
2. **B1** — the plan gate. Independent of everything else, and it's the last unguarded path.
3. **A3 + A4** — read-back and outcome joins, once the data is queryable.
4. **B2, B3, D1** — small, independent, each fixing a specific known annoyance.
5. **A5** — transcript viewer.
6. **C1** — the dashboard redesign, with C2 and C3 landing inside or after it.
7. **A6** — charts, last in the data chain by design.
8. **B4** — type-driven behavior; largest item, and best split once the review checklist proves out.

---

## Rejected on 2026-08-16

Recorded so they aren't re-proposed without new information. Reasons are the ones that decided
the call, not exhaustive arguments.

| # | Candidate | Why not |
|---|---|---|
| 1 | CI workflows for this repo (typecheck/test, Windows runner) | Declined; no reason recorded. Note the standing consequence: `loop/automerge.ts` counts a PR with **zero checks as green**, so on this repo auto-merge is gated on approval alone |
| 2 | Resume the worker when its PR's CI goes red | Declined; no reason recorded. `gh pr checks` is already fetched for auto-merge, so this stays cheap if it's ever wanted |
| 9 | Auto-file unfixed machine-review findings as not-ready tickets | Backlog noise outweighs findings that didn't justify the fix round |
| 10 | Warm worktree pool | Latency-only win on an async system; `fleet.yaml` profile selection makes pre-warming a guess |
| 12 | `doctor` command | Diagnostics for a single-operator setup that works; the checks fail loudly on their own |
| 14 | Draft-PR mode | Contradicts auto-merge (GitHub won't merge a draft); no reviewers to spare notifications |
| 15 | Global `maxTotalConcurrent` | Budget gate + work-hours reserve + per-project pause already govern this |
| 16 | Webhook mode | Public reachability and per-repo secrets to save <1 min of latency nobody watches |
| 17 | Prompts out of code (`templates/prompts/*.md`) | Contracts are behavior enforced by adjacent code; adds a startup failure mode |
| 19 | Recursive decomposition (`tier: "plan"`) | Two-level epics usually signal bad scoping; multiplies unattended fan-out risk |
| 20 | Re-planning action | Rescoping is a human call; the automated version's main new power is closing tickets |
| 21 | `/api/metrics` (Prometheus) | No scrape target exists; OTel would be the better source if one ever did |
| 22 | E2E harness with a fake `gh` | A hand-written GitHub simulator can drift and pass while production breaks |
| 24 | Live journal tail over `/ws` | Seconds of freshness for the first payload-carrying, subscription-based WS message |
| 28 | Bulk refinement operations | GitHub's issue list already does bulk labeling |
| 29 | Per-project config toggles in the dashboard | Two-sources-of-truth problem (config file vs. database) unsolved; these are set-once settings |
| 30 | OTel opt-in | Small fleet-side diff, worthless without a collector and Grafana that aren't run |
| 31 | `ticket_events` / event-sourced records | A1 covers it — journal fleet events instead, and query them |
| 33 | Off-hours mode | Inverts the one-way gate design to buy more unattended claiming |
| 34 | Priority aging | The backlog just hit zero; no starvation problem to solve |
| 35 | `/fleet ...` directive comments | Emphatic plain comments already work; a typo'd prefix silently downgrades an instruction |
| 36 | Digest posted to GitHub | Third surface for content already on the dashboard and Discord |
| 37 | LLM triage at intake | Deterministic lint (#133) covers the crude cases. **Revisit if** A3/A4 data shows lint-passing tickets still failing often |
| 38 | Repo-owned template overlay | B4 takes the behavioral half into `fleet.yaml`; the rest is presentation repos can already edit |
| 40 | Trusted daemon stacking | No second daemon, and nothing files unattended work now that #9 is out. Prerequisite if multi-operator becomes real |
