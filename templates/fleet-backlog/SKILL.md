---
name: fleet-backlog
description: File well-formed tickets into this project's fleet backlog via the fleet MCP tools, and evaluate how past fleet tickets went (outcomes, cost, review friction). Use proactively when you notice out-of-scope work worth queuing (a bug, a follow-up, a piece of tech debt) while doing something else, or whenever the user asks to file, queue, backlog, or track work for fleet — or asks how fleet has been performing.
---

# fleet-backlog

Fleet is this repo's backlog orchestrator: tickets are GitHub issues, and a daemon picks up ready ones and runs them as autonomous worker sessions. GitHub is the single source of truth — these tools only talk to the fleet daemon, which is the only thing that touches the issue queue.

## When to use this

- You're mid-task and notice something else worth doing (a bug, a missing test, a refactor) that's out of scope for the current work.
- The user explicitly asks to file, queue, backlog, or track something for fleet.

Don't use this for the work you're currently doing — finish that yourself. This is for work you're deliberately deferring.

## Steps

1. **Dedup first.** Call `fleet_query_backlog` and check whether an existing ticket already covers this. If one does, stop — don't file a duplicate. If it's close but not quite the same scope, mention the existing ticket to the user instead of filing blindly.

2. **Write a self-contained ticket.** The worker that eventually picks this up has no memory of this conversation — it only sees the issue body. Include:
   - **Problem statement** — what's wrong or missing, and why it matters.
   - **Exact file paths** where the relevant code lives, if you know them.
   - **Acceptance criteria** — what "done" looks like, as a concrete, checkable list.
   - **Verification steps** — the commands or checks a worker should run to confirm the fix (tests, typecheck, lint, a manual repro).

   A ticket that just says "fix the flaky test" is not enough. A ticket that names the test file, describes the failure mode you observed, and lists the command to reproduce it is.

   Use an actual markdown heading for each (e.g. `## Problem`, `## Acceptance criteria`, `## Verification`) — fleet's intake lint rejects a `fleet:ready` body missing one of these before a worker ever picks it up.

3. **Pick a priority.** `p1` for user-facing bugs or blockers, `p2` for the default case, `p3` for nice-to-haves and minor cleanups. Omit it if you're unsure — a human can triage.

4. **File it** with `fleet_file_ticket`, passing `title`, `body`, and optionally `priority`, `ready`, and `dependsOn`. Leave `ready` at its default (true) unless the ticket needs human curation before a worker should pick it up. Use `dependsOn` (issue numbers) when this ticket shouldn't be picked up until other tickets close.

5. **Tell the user** what you filed, with the issue number and URL the tool returns, and continue with your original task.

## Refining an existing ticket

Prefer commenting on the issue over editing the body. At claim time the worker's first prompt includes the issue body and every comment on it, read fresh — so a comment added before the ticket is claimed is just as effective as editing the body, without disturbing the original problem statement. Reserve body edits for genuine rescoping.

## Evaluating past work

When the user asks how fleet has been doing, whether a past ticket went well, or what similar work has cost — or you want a baseline before filing something — use the read-only evaluation tools:

1. **Start with `fleet_ticket_history`** for the closed-ticket record: per-ticket outcomes (PR merged vs. closed, cost, model, review rounds, whether a human had to rework the output) plus aggregates over everything matching the filter. It defaults to this project and the 10 most recent closures; pass `since`/`until` to scope a period, or `allProjects: true` for the whole fleet.
2. **Drill into one ticket with `fleet_ticket_report`** — tool-call and error counts, per-session cost/turns/duration, approval wait times, machine-review findings. This is the "why was this ticket slow or expensive" view.
3. **Read `fleet_ticket_journal` when you need the story** — a one-line-per-entry narrative of what the worker actually did. Reach for it after the report points at something odd, not as a first stop; it's the most verbose of the three.

These tools read the daemon's archive, so they only cover tickets fleet itself ran — issues closed outside fleet won't appear.

## Tools

- `fleet_query_backlog` — lists this project's current tickets (number, title, status, priority). No input.
- `fleet_file_ticket` — files a new ticket. Input: `{ title, body, priority?: "p1"|"p2"|"p3", ready?: boolean, dependsOn?: number[] }`.
- `fleet_board_status` — per-column ticket counts across all fleet-managed projects, plus currently running tickets and their latest activity. Useful context if the user asks "what's fleet up to".
- `fleet_ticket_history` — closed tickets with outcomes and aggregates. Input: `{ since?, until?, limit? (default 10), allProjects? }`.
- `fleet_ticket_report` — one ticket's session stats. Input: `{ issue, project? }`.
- `fleet_ticket_journal` — one ticket's journal tail. Input: `{ issue, project?, limit? (default 50) }`.
