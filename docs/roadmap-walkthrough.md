# Fleet — Roadmap Walkthrough Notes

Decisions and directions from a guided Q&A walkthrough (August 2026), covering ground
the earlier docs don't: trust & multi-user, usage-aware scheduling, the human refinement
workflow, PR lifecycle, deployment/runtime, and dashboard direction.

Unlike `improvement-ideas.md` and `analytics-ideas.md` (open idea menus), this file
records **chosen directions** — each section notes what was decided, what's opt-in,
and what's explicitly out of scope.

---

## 1. Trust model & multi-user fleet

**Target state:** multiple people, each running fleet locally, pointed at the same
project/repo. This makes GitHub the coordination point — which fleet is well positioned
for, since labels are already the source of truth.

Directions (all worth pursuing; none decided as the single mechanism yet):

- **Ownership becomes first-class.** Fleet currently has no concept of a ticket's owner.
  The routing pattern to support: *the person who curated/reviewed a ticket is whose
  daemon picks it up*. Candidate mechanisms, likely in combination:
  - **Assignee-based claiming** — claiming sets the GitHub assignee to the daemon
    operator's account; daemons skip issues assigned to someone else; pre-assigning
    routes a ticket to a specific person's fleet.
  - **Claim-stamp labels** (`fleet:owner:<username>`) — visible on every board without
    disturbing assignee semantics.
  - **Status-comment handshake** — daemon identity written into the status comment at
    claim; other daemons back off.
- **Contributor check (include regardless):** only claim tickets filed or labeled by
  repo collaborators — a floor under "anyone who can open an issue steers an agent with
  Bash access." GitHub-side hardening to investigate: restricting who can apply
  `fleet:*` labels (label permissions follow triage-role rules, so this is partly
  achievable with role management).
- **Open problems any mechanism must answer:**
  - *Race story* — two daemons claiming in the same poll window (label swap is not
    atomic; assignee-set-then-verify is closer to a compare-and-swap).
  - *Stale owner story* — a daemon that claimed and died; other daemons need a way to
    detect abandonment (no status-comment heartbeat after N minutes) and release or
    take over.
  - *Trusted daemons stacking* — one person's fleet working on top of another's output
    (e.g. picking up auto-filed follow-ups from a ticket someone else's fleet ran).
- Deeper hardening (worker sandboxing, injection screening) folds into the Docker
  direction in §6 rather than being separate work.

## 2. Usage-aware scheduling

Constraint acknowledged: **no API exposes remaining plan usage**, so fleet self-estimates
by accounting its own token spend per limit window (it already captures per-session
usage; OTel per §4 of `analytics-ideas.md` tightens it). Accepted as good enough,
knowing interactive Claude use on the same plan causes drift.

- **Budget threshold (wanted):** config like "assume N tokens / $X per 5-hour window;
  past ~85% of it, claim `fleet:light` tickets only." Heavy/elevated tickets hold until
  the window resets.
- **Work-hours reserve (default behavior, wanted):** the simplest shape wins — a
  **hard stop on claims N hours before configured working hours begin**, so the human
  starts their day with full plan capacity. Config: working hours + reserve buffer.
- **Off-hours mode (very opt-in):** "claim aggressively overnight/weekends." Key design
  note from the walkthrough: this requires **extending the pause machinery so an
  automatic resume can fire inside the off-hours window** — today `pausedUntil` and
  operator pause only gate claims; off-hours mode adds a schedule that *lifts* the gate
  on its own. Because auto-resuming while nobody is watching is the risky part, the
  feature must be a deliberate fleet-wide opt-in, not a default.
- **Priority aging** (starvation guard for p3s): noted, no strong pull; revisit later.

## 3. The human refinement workflow

Chosen term: **refinement** (not grooming). It should be a designed, documented part of
the workflow, not an accident.

- **Comments are the refinement surface.** Confirmed against the code: at claim time
  fleet already includes all issue comments in the worker's first message and reads the
  body fresh — so refinement by *adding comments* is fully effective pre-claim today.
  Nobody should have to edit the original body for routine refinement; body edits are
  reserved for genuine rescoping. This becomes documentation (README + the fleet-backlog
  skill) rather than new machinery.
- **Mid-flight comment ingestion (build):** the real gap — new human comments on an
  *in-progress* ticket currently go nowhere. Inject them into the live session using the
  same watermark pattern as PR-review feedback (`lastReviewHandledAt` analog for issue
  comments, filtering out fleet's own status comment). This matters doubly for
  multi-user: only the daemon operator has the dashboard reply box; teammates steer via
  the issue.
- **Curation gate for machine-filed tickets (principle adopted):** *machine-filed
  tickets are never born ready.* Auto-filed leftovers (below) and plan children default
  to needing a human pass before `fleet:ready`. In multi-user fleet, the person who
  reviews/readies a ticket is naturally its owner (§1).
- **Directive comments** (`/fleet prefer X` given elevated weight in the prompt): open
  idea, lower priority than the two above.

## 4. Worker behavior

- **One-loop principle (affirmed):** the single fix/retry round exists to cap token
  spend. *If the model can't do it, a human takes over.* Retries beyond the existing
  once-per-mechanism budgets are only justified for **genuinely transient** failures
  (network blips, tool crashes, limit hits) — never "try the same work again harder."
- **Failure triage on the issue (build):** when a ticket fails, write a machine-authored
  post-mortem into the status comment — what was attempted, where it died, what a human
  should look at — so triage doesn't require reading journals.
- **Richer prompt context (build; detailed design):** enrich `buildIssuePrompt` — pure
  prompt assembly, no new session machinery:
  - last ~10 commits + blame summary for files named in the issue;
  - precedent PRs: merged PRs touching the same paths (titles + descriptions) so the
    worker inherits local conventions;
  - `#refs` resolved to title/state/closing PR;
  - prior-attempt memory: on restart/resume-after-failure, include the previous
    session's summary and failure reason (today a restart starts from zero);
  - each block capped; per-project toggle; optional light-model compression pass.
- **Auto-file leftover findings (build, gated):** minor machine-review findings that
  don't get fixed become auto-filed tickets — filed *not-ready* per the curation gate
  in §3.
- Best-of-N parallel attempts: not pursued now (token spend, same reasoning as the
  one-loop principle).

## 5. PR lifecycle

- **Auto-merge — fleet-driven (decided):** fleet already polls PR reviews each cycle;
  when it sees an approval from an **authorized approver** plus green CI, it merges via
  `gh pr merge`. Authorization is a per-project `approvers` allowlist **defaulting to
  the account the daemon's `gh` is logged in as** — i.e. tied to the user running fleet,
  by default. Composes with multi-user: your daemon merges on your approval; a
  teammate's approval counts only if you list them. (GitHub-native auto-merge was
  considered and rejected: approval authority would be governed by repo settings, not
  fleet.)
- **Issue linking (build):** fleet appends `Closes #N` to every PR body itself instead
  of trusting the worker's prBody to remember, so merge always closes the issue.
- **One PR per issue (invariant affirmed):** current close-on-merge behavior is correct
  because each ticket is scoped to be solvable in one PR. Multi-PR issues are a ticket-
  scoping failure to fix at refinement/planning time, not a lifecycle feature.

## 6. Runtime, Docker, and the restart story

Context: fleet already dogfoods (the build machine's fleet watches the fleet repo), so
"how does the daemon restart cleanly" is load-bearing — it's how fleet-on-fleet changes
deploy.

- **Docker is the preferred direction (decided: option C, with A as fallback):**
  - The container runtime is the supervisor: `restart: unless-stopped` gives crash
    recovery; deploy = rebuild/restart the container.
  - **Fallback if Docker doesn't land:** the supervisor-wrapper (~50-line loop that
    relaunches the daemon on a "restart me" exit code, with crash backoff).
  - Either way, the daemon grows `POST /api/daemon/restart` (drain via the existing
    shutdown machinery, then exit-for-relaunch) and a `fleet update` command
    (pull latest → trigger restart). These are identical in both worlds; only the
    relauncher differs.
- **The auth blocker to verify first:** the reason Docker isn't in use today is Claude
  CLI auth on a subscription plan (no desire to switch to API keys). To investigate:
  `claude setup-token`, which produces a long-lived OAuth token
  (`CLAUDE_CODE_OAUTH_TOKEN`) intended for headless use on subscription plans — if it
  works as documented, containerized workers become possible without the API. Verify
  against current docs before building anything on it.
- **Platform target:** if Docker lands, support both Windows and macOS hosts.
- Sandboxing benefits from §1 (worker isolation) arrive as a side effect of
  containerized workers.

## 7. Worktrees & provisioning performance

- **Worktrees stay.** Branches alone can't work — branches share one working directory,
  so two live sessions would stomp each other. Worktrees (or per-worker containers) are
  the correct isolation.
- **Cheapest win — pnpm everywhere:** pnpm's global content-addressable store is shared
  per machine, so `pnpm install` in a fresh worktree is mostly linking, not downloading.
  Projects still on npm/yarn pay the full cost; migrating them is the biggest lever.
- **Warm worktree pool (build):** after each claim, pre-provision the *next* worktree +
  setupCommand in the background so the next claim starts instantly. This achieves what
  the "have a cheap model provision worktrees first" idea wanted — but provisioning is
  deterministic shell work, so no model (and no tokens) should be involved at all.
  (Model-based provisioning: explicitly rejected.)

## 8. Dashboard direction

Framing (affirmed): **the board is the product — a tool for the engineer, not a
replacement.** All four proposed directions worth pursuing: attention-first "needs me"
queue, in-board diff preview, live transcript view, bulk refinement operations.

- **Scale model (clarified):** many projects *connected*, only 1–2 *actively worked* at
  a time — token budget, not UI, is the real concurrency limit. The key primitive this
  demands is **per-project pause/activate** (today pause is fleet-wide only): the
  connected-but-dormant set stays visible on the board while claims flow only to the
  active few. The dashboard redesign should treat "active vs. dormant projects" as the
  primary organizing distinction — dormant projects collapse to rollup rows,
  active ones get the full board.
- Broader many-project design review (the current layout works because only a couple of
  projects exist): folded into the same redesign.
- Config UX (per-project toggles editable from the dashboard — pause, machineReview,
  etc.): wanted, with the note that it needs real UI design as part of the
  many-projects rework, not bolted on.

## 9. Notifications & the daily digest

Guiding constraint: **don't bombard the engineer.** Defaults stay quiet.

- **Default surface: the dashboard UI.** Nothing pushes externally out of the box.
- **Discord webhook (opt-in channel to build first):** for needs-input, PR-opened,
  failure, and pause events — chosen over toast/ntfy/Slack/email.
- **Daily digest (build):** "overnight fleet completed 3 tickets (PRs #12/#14/#15
  awaiting review), 1 blocked on a question, spent ~$4.20, review queue 3/3 so claims
  held." **Default: rendered in the dashboard**; optionally posted to GitHub (e.g. a
  discussion) as an opt-in. Pairs naturally with off-hours mode (§2) — the digest is
  the morning landing page for what happened while you slept.

## 10. Explicit non-goals

Recording these is as useful as the features:

- **Cross-repo tickets** — out of scope. One ticket = one repo = one PR stays a
  simplifying invariant.
- **Switching to API-key billing** — not wanted; subscription plan is the constraint to
  design within (drives §2 and the §6 auth verification).
- **Model-based worktree provisioning** — rejected; provisioning is deterministic work.
- **Unbounded/expanded retry loops** — rejected; one loop, then a human (§4).
- **Bombarding notification defaults** — rejected; quiet by default, opt-in channels.

---

## Rough build order implied by the walkthrough

1. **Refinement workflow docs + mid-flight comment ingestion** (§3) — small, immediately
   useful, and the multi-user prerequisite.
2. **Per-project pause** (§8) — the primitive the real usage pattern (many connected,
   few active) already needs today.
3. **Work-hours reserve + budget threshold** (§2) — protects the plan window fleet and
   the human share.
4. **Failure post-mortem comment + `Closes #N` + fleet-driven auto-merge** (§4, §5) —
   rounds out the ticket lifecycle end-to-end.
5. **Verify `claude setup-token` in a container** (§6) — cheap experiment that unblocks
   (or rules out) the whole Docker direction; restart API + `fleet update` follow it.
6. **Ownership/claiming mechanism for multi-daemon** (§1) — the largest design piece;
   informed by everything above landing first.
