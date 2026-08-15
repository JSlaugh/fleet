# Fleet — Analytics & Data Ownership Ideas

Companion to `improvement-ideas.md`, focused on the data/analytics layer: what fleet
retains today, where the format fights you, how to link out to the data Claude itself
keeps per session, and how to capture more granularly — with the end goal of **owning
enough of the data to judge what's valuable and what isn't**.

Claude-side facts below (transcript paths, OTel, retention) were verified against the
Claude Code / Agent SDK docs as of August 2026; doc links are inline.

---

## 1. What fleet retains today — and where it leaks

| Store | File | Contents | Failure mode |
|---|---|---|---|
| State | `.fleet/state.json` | Live `TicketRecord`s: session id, cost, per-model usage, flags (`elevated`, `autoResumed`, `machineReviewOutcome`, …) | Record is *overwritten in place* — every update destroys the previous value; no history of transitions |
| History | `.fleet/history.json` | `ClosedTicketRecord`s, capped at 1000 (`HISTORY_LIMIT` in `state.ts` — note CLAUDE.md still says 50, stale) | Past the cap, records are **deleted**. The archive you'd want for long-term analysis is the thing being trimmed |
| Journal | `.fleet/journals/<project>/<issue>.jsonl` | Per-ticket summarized SDK messages | Lossy at the capture point (below); never pruned, but also never joined back to anything |
| GitHub | Status comments, labels, PRs | Human-readable state | Continuously *upserted* — each update overwrites the previous status text |

The single biggest leak is `summarize()` in `packages/daemon/src/worker.ts`: fleet sits
in-process on the **full-fidelity** SDK message stream and voluntarily throws most of it
away before writing the journal:

- assistant text truncated to 1,000 chars; tool inputs to 200 chars
- tool **results** reduced to `{id, isError}` — no output, no size, no duration
- thinking blocks, user/steering messages, and per-message token usage not captured at all
- no cache-read/cache-write token split (the SDK result carries it; fleet keeps only
  input/output totals per model)

Everything downstream (`computeTicketReport` in `server.ts`, `computeHistoryAggregates`
in `history.ts`) can only aggregate what survived this funnel. So "the format it retains
isn't helpful" is mostly a symptom of *summarize-then-discard*: the analysis you want to
do next month is constrained by a truncation decision made at capture time.

---

## 2. Options for the retained format

Ordered roughly from least to most invasive.

### 2a. Widen the funnel (keep JSONL)

Cheapest fix: make `summarize()` less lossy and add what's missing, keeping the
format identical.

- Persist per-message **usage** (input/output/cache-read/cache-write tokens) on assistant
  entries — the SDK message carries it.
- Persist tool-result **metadata**: duration (delta from the matching `tool_use`
  timestamp), output byte size, and the first ~500 chars of error text when `isError`.
- Record **fleet-decision events** that currently only appear in `log()` lines or not at
  all: PreToolUse denials (`denyForbiddenBash` firing is a strong "worker tried to go
  off-contract" signal), approval requests with outcome + wait time, machine-review
  findings (count, severities, files), fix-round deltas, auto-elevation, stall/resume,
  review-feedback resumptions. Most of these are one `journal.append()` at a site that
  already exists.
- Add a `v` (schema version) field to every entry now — `computeTicketReport` is already
  written defensively against old shapes; a version field makes that explicit and cheap
  forever.

### 2b. Raw transcript retention (own the full stream)

Add a per-project or global `journalMode: "summary" | "full"`. In `full` mode, append the
complete `SDKMessage` JSON alongside (or instead of) the summary entry — fleet already
holds the object; it's one `JSON.stringify` from being owned forever. Disk is the only
cost, and JSONL compresses extremely well (gzip old journals on ticket archive).

This is the highest-leverage "own the data" move available: **you cannot retroactively
un-truncate**, but you can always re-summarize raw data later once you know which
questions matter. Ship raw mode, keep it on for a month, then decide what the summary
format should have been — with evidence.

### 2c. SQLite instead of JSON files

`state.json` rewrites the whole file on every update; `history.json` exists only because
querying JSONL is awkward; the 1000-record cap exists only because the file is loaded
whole. One SQLite file (`.fleet/fleet.db`, via `node:sqlite` — built into Node 22+, no
native dep) with `tickets`, `ticket_events`, `sessions`, and `journal_entries` tables:

- kills the history cap (millions of rows are nothing),
- makes every dashboard aggregation a query instead of bespoke reduce code
  (`computeHistoryAggregates`, `computeTicketReport` become SQL views),
- gives you ad-hoc analysis for free: `sqlite3 .fleet/fleet.db` or open it in
  DuckDB/Datasette/any notebook — which is exactly the "see what is valuable" workflow.

Migration is mechanical (`StateStore`/`HistoryStore` keep their interfaces; a one-time
import reads the JSON files). Journals could stay JSONL (append-only files are a fine
fit) with only the *derived* per-entry index going into the DB.

### 2d. Event-sourced ticket records

Deeper cut: treat `TicketRecord` mutation as the problem. Append every transition to a
`ticket_events` log (`claimed`, `turn-finished`, `review-found-3-findings`, `pushed`,
`pr-opened`, `stalled`, `resumed`, `archived`, each with a timestamp and payload) and make
`state.json`/board a projection. You then get, for free, the questions the current shape
can't answer: time-in-state per ticket, how often tickets bounce ready→needs-input→ready,
what preceded every failure. Combines naturally with 2c (the event table) and is the
analytics-grade version of what the journal's `type: "fleet"` entries already gesture at.

### 2e. Stop deleting at archive time

Even without 2c/2d: when `HistoryStore` trims past the cap, write the trimmed records to
`.fleet/history-archive/<year>.jsonl` instead of dropping them; when a ticket is cleaned
up, gzip its journal rather than orphaning it. Data you own should age into cold storage,
not disappear.

---

## 3. Linking out to Claude's own session data

Short answer: **yes for local files, no for claude.ai.** What the docs confirm:

- **Full transcripts exist on disk.** Every worker session's complete transcript —
  including everything `summarize()` drops — is written by the CLI to
  `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`, where `<sanitized-cwd>` is the
  session's working directory with non-alphanumerics replaced by `-`. Agent SDK sessions
  write these exactly like interactive ones.
  ([Sessions docs](https://code.claude.com/docs/en/sessions.md))
- **Fleet can compute the path.** A ticket's `worktreePath` + `sessionId` (both already
  on `TicketRecord`) fully determine the transcript file. Ideas, in increasing effort:
  1. Show the path (and a `claude --resume <sessionId>` command) in the dashboard's
     ticket detail — resume-by-id works from any directory on recent CLI versions.
  2. Serve the transcript through the daemon (`GET /api/tickets/:project/:issue/transcript`)
     with a raw viewer in the dashboard — the "view what Claude has on this session"
     button, no claude.ai needed.
  3. The SDK's `listSessions()` / `getSessionMessages()` read these programmatically —
     a supported alternative to parsing the JSONL yourself (its internal format is
     explicitly undocumented and version-unstable).
- **Retention is the catch: default is ~30 days from last access** (`cleanupPeriodDays`
  in settings.json). If fleet wants to *own* this data, copy (or hard-link) the
  transcript into `.fleet/transcripts/<project>/<issue>/<session-id>.jsonl` at
  ticket-archive time — this single feature gets you ~everything section 2b offers
  without touching the capture path, at the cost of depending on an unstable format.
  Raising `cleanupPeriodDays` is the zero-code stopgap.
- **No claude.ai link for local sessions.** Locally-run CLI/SDK sessions are not
  viewable on claude.ai — that's only for sessions started in the cloud
  (claude.ai/code). There's no push-local-session-to-web from the CLI. So the dashboard
  transcript viewer (above) isn't a workaround, it *is* the product.
- **Usage APIs don't apply to Max plans.** The Admin Usage & Cost API and Claude Code
  Analytics API are for API-key/Enterprise orgs; on a subscription plan there's no
  programmatic usage endpoint. Fleet's own capture (SDK result messages + OTel below) is
  the source of truth available to you — one more argument for owning it.

---

## 4. Tracking more granularly: OpenTelemetry

Claude Code has a full OTel pipeline, and it works for SDK-spawned sessions — the env
vars just need to reach the spawned CLI (the SDK's `options.env`; fleet currently doesn't
set `env`, so this is a small `runner.ts`/`worker.ts` change).
([Monitoring docs](https://code.claude.com/docs/en/monitoring-usage.md),
[SDK observability](https://code.claude.com/docs/en/agent-sdk/observability.md))

- **Metrics:** `claude_code.token.usage`, `cost.usage`, `session.count`,
  `lines_of_code.count`, `commit.count`, `pull_request.count`.
- **Events:** `user_prompt`, `assistant_response`, `tool_result`, `tool_decision`,
  `api_request`, `api_error`, `internal_error` — with opt-in flags for prompt text
  (`OTEL_LOG_USER_PROMPTS=1`), tool parameters (`OTEL_LOG_TOOL_DETAILS=1`), and even full
  raw API request/response bodies (`OTEL_LOG_RAW_API_BODIES=1` — the maximal
  own-everything switch).
- **Setup sketch:** run a local OTel collector (or just `otel-collector` →
  Prometheus + Loki, all self-hosted = all owned), then per worker session set
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
  `OTEL_LOGS_EXPORTER=otlp`, endpoint env vars, and — the fleet-specific part —
  `OTEL_RESOURCE_ATTRIBUTES=fleet.project=<name>,fleet.issue=<n>,fleet.kind=<code|plan>`
  so every metric and event is dimensioned by ticket. Grafana over that answers
  cost/tool/error questions per project/ticket/model without fleet writing any
  aggregation code.

OTel and the journal overlap but serve different masters: OTel gives you dashboards,
alerting, and API-level granularity (per-request tokens, api_error events) with zero
schema work; the journal/DB is what the fleet dashboard and its own logic read. Running
both for a while is a legitimate way to learn which granularity you actually use — the
stated goal.

---

## 5. New signals worth capturing (regardless of format)

Things fleet is positioned to record but currently doesn't, roughly ordered by how much
they'd sharpen the "what is valuable" question:

- **Outcome joins.** The most valuable analytics link *effort* to *outcome*. At cleanup
  time fleet already fetches PR state; also record: time-to-merge, whether a human pushed
  commits to the fleet branch after the PR opened (i.e. the worker's output needed manual
  rework — `gh pr view` exposes commits/authors), number of human review rounds, and
  review-comment count. "Cost per *cleanly merged* PR, by model tier and ticket type" is
  the metric everything else feeds.
- **Machine-review efficacy.** Persist each review's findings (count, severities, files)
  and what the fix round changed. Over time: how often does the gate catch something real
  vs. burn a fix round on noise? That decides whether `machineReview` earns its cost.
- **Fix-round / steering deltas.** Tokens and wall-clock per session *segment* already
  exist (`SessionSegmentReport`); attribute segments to their cause (initial run,
  machine-review fix, review feedback, stall resume, operator reply) so you can see what
  each recovery mechanism costs and how often it succeeds.
- **Contract violations.** Count `denyForbiddenBash` firings per session — a rising rate
  on a model/type combination is an early-warning signal no summary currently surfaces.
- **Approval latency.** Time from approval-request to human answer (or timeout-deny) —
  measures the human bottleneck the `approvalTimeoutMinutes` auto-deny papers over.
- **Cache economics.** Cache-read vs cache-write vs fresh input tokens per session —
  long sessions with poor cache hit rates are where cost hides.
- **Wall-clock decomposition.** `durationMs` from result messages vs. total
  ticket wall-clock: how much of a ticket's life is model time vs. waiting (approvals,
  replies, pauses, poll latency).

---

## 6. Suggested sequence

1. **Copy transcripts at archive time + raise `cleanupPeriodDays`** (§3) — zero-risk,
   immediately stops irreversible data loss while everything else is decided.
2. **Widen `summarize()` + add fleet-decision events with a schema version** (§2a) —
   small diffs at existing call sites; makes the journal analytically honest.
3. **OTel opt-in per project** (§4) — the granular pipeline, with ticket-dimensioned
   resource attributes; learn from a few weeks of Grafana which dimensions matter.
4. **SQLite consolidation** (§2c, optionally §2d) — once 1–3 have shown which queries you
   actually run, move the stores to a queryable shape and delete the caps.

The theme: capture raw now, decide schema later. Every idea above that deletes or
truncates *later* is recoverable; nothing truncated *at capture* ever is.
