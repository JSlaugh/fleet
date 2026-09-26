# Plan: Fleet MCP server that works without a running daemon

Status: implemented. Every phase landed on the `claude/codex-claude-comparison-6h7i6w` branch; kept as the design record.

## 1. Problem

`@fleet/mcp` is a stdio MCP server whose every tool is an HTTP call to the daemon's REST API.
It reads two environment variables, `FLEET_PROJECT` and `FLEET_URL`, and nothing else. When no
daemon answers at `FLEET_URL`, every tool fails, including filing a ticket.

Two people this blocks:

- A developer who only files ideas, often from Codex rather than Claude, and has no daemon at
  all.
- A developer whose daemon is on another machine or is simply not running right now.

GitHub labels are Fleet's source of truth. The daemon polls for `fleet:ready` issues; it does
not need to be the one that created them. So an issue created directly with the right labels
is a fully valid ticket, daemon or no daemon.

## 2. The rule this plan is built on

**Writes and backlog reads go to GitHub. Derived-state reads go to the daemon.**

Filing a ticket and listing the backlog only need GitHub. Board status, history, ticket
reports, and journals read `fleet.db`, which exists only inside the daemon. Each MCP tool has
exactly one home, so there is no "mode" and no capability matrix, just two small clients and a
registration step that skips the daemon tools when no daemon is configured.

Why not keep filing through the daemon API when it is available:

- Once the filing logic is shared (section 5, phase 0), both paths produce a byte-identical
  issue. The API hop adds nothing.
- The API's backlog endpoint reads the daemon's board cache, which is up to one poll cycle
  stale. `gh issue list` is live. Direct is better for dedup, not worse.
- Issues filed directly are authored by the developer, not by whatever account the daemon
  runs as. That is the more honest record.
- The one thing lost is a non-developer filing through a teammate's daemon with no GitHub
  login of their own. Anyone filing tickets for a repo already has `gh` set up. We do not
  design around that case.

The dashboard's ticket form still posts to `POST /api/projects/:project/tickets`. That route
stays and calls the same shared function.

## 3. Design goals

1. One ticket-filing contract, shared by the REST handler and the MCP. No drift possible.
2. The MCP stays thin: a repo slug, an optional daemon URL, and a set of tools.
3. `fleet.config.json` is never required by the MCP, but is used when present.
4. Adding a new way to reach the backlog later is a new adapter file, not new branches inside
   tools.
5. Zero-config for the direct case: a repo slug and an authenticated `gh`.

## 4. Structure

### 4.1 Packages

```
packages/
  shared/                       types, zod schemas, pure helpers (unchanged role)
    src/ticket-intake.ts        NEW  CreateTicketSchema, labelsForNewTicket, bodyWithDependsOn
                                     (moved from daemon/src/server/server.ts)
    src/config.ts               ADD  ProjectsOnlyConfigSchema: lenient {projects:[{name,githubRepo}]}
  github/                       NEW  @fleet/github: "talk to GitHub through gh"
    src/exec.ts                 moved from daemon/src/github/exec.ts
    src/issues.ts               createIssue, getIssue, listFleetIssues, ensureLabels,
                                issueNumberFromUrl, clampBody (moved from daemon github.ts)
    src/index.ts                barrel
  daemon/
    src/github/github.ts        keeps PR, worktree, status-comment, assignee helpers;
                                imports the issue helpers from @fleet/github
    src/server/server.ts        ticket route imports from @fleet/shared ticket-intake
  mcp/
    src/tickets.ts              GitHub-backed: fileTicket, queryBacklog  (uses @fleet/github)
    src/daemon.ts               REST-backed: boardStatus, history, ticketReport, ticketJournal
                                (today's client.ts minus the two ticket functions)
    src/resolve.ts              env + optional config -> { repo, project, daemonUrl? }
                                the only file that reads process.env or the filesystem
    src/tools/                  one file per tool; imports only tickets.ts or daemon.ts
      file-ticket.ts
      query-backlog.ts
      board-status.ts
      history.ts
      ticket-report.ts
      ticket-journal.ts
    src/index.ts                resolve(); register ticket tools; register daemon tools
                                only when daemonUrl is set
```

Why a new `@fleet/github` package rather than folding into `@fleet/shared`: shared is bundled
into the dashboard by Vite and today has no `child_process` dependency. Putting process
spawning there is a smell and makes tree-shaking matter for correctness. A separate package
that daemon and mcp depend on, and the dashboard never does, follows the same "split by
concern" rule CLAUDE.md already states for shared, one level up.

The issue helpers currently take a `ProjectConfig`. They read only `githubRepo`, so they
narrow to `{ githubRepo: string }`. Daemon call sites keep passing `project`, which is
structurally compatible.

### 4.2 Resolution

`resolve.ts` produces `{ repo, project?, daemonUrl? }`. Rules, most explicit first:

| Input | Result |
|---|---|
| `FLEET_REPO=owner/name` | `repo` from it directly |
| else `FLEET_PROJECT` set and a config found | `repo` = that project's `githubRepo` |
| else | fail: "set FLEET_REPO, or FLEET_PROJECT with a reachable fleet.config.json" |
| `FLEET_URL` set | `daemonUrl` = it |
| else config found **and it names `dashboardPort`** | `daemonUrl` = `http://localhost:<that port>` |
| else | no daemon tools |

Config discovery reuses the upward search `loadConfig` in the daemon already does, with an
optional `FLEET_CONFIG` path override, but parses with `ProjectsOnlyConfigSchema`. (Decided
during implementation: a projects-only config never implies a daemon — only an explicit
`dashboardPort` does — so a no-daemon user's tool list stays to the two GitHub tools. The
daemon's own `sync-templates` stamps `FLEET_URL` explicitly, so daemon users lose nothing.) That schema
validates only `projects[].name` and `projects[].githubRepo`. A daemon-only field being wrong
or missing must never stop a ticket from being filed.

No automatic fallback in either direction and no probing. If `daemonUrl` resolves but the
daemon is down, the four daemon tools are registered and return a clear error when called.
Hiding them based on a boot-time probe would make the tool list change between sessions for
reasons the agent cannot see.

Effect on the stamped `.mcp.json`: today's template (`FLEET_PROJECT` + `FLEET_URL` +
`FLEET_DIR`) keeps working unchanged, because the project name resolves through the config
next to `FLEET_DIR`. A Codex-only user with no daemon writes an entry with just `FLEET_REPO`.

### 4.3 The GitHub ticket client

`tickets.ts`, built entirely from `@fleet/github` and `@fleet/shared`:

- `fileTicket`: run `lintIntakeBody` first, the same gate the daemon's claim path and the
  dashboard form run, and refuse a malformed body with the same section list the daemon would
  post. Then `labelsForNewTicket`, `bodyWithDependsOn`, `createIssue`. Identical to the REST
  handler by construction, since it is the same function.
- `queryBacklog`: `listFleetIssues` over open issues, mapped to `{ number, title, status,
  priority, url }` with `status` derived from the `fleet:*` label the way `board.ts` does.
- Labels: call `ensureLabels` lazily on the first `fileTicket` per process. It is idempotent,
  and this removes the last manual setup step (`pnpm daemon init-labels`) for a fresh repo.

### 4.4 Tool descriptions

`fleet_file_ticket`'s description tells the agent to check the backlog first. That stays
accurate in both setups since `fleet_query_backlog` is always present. Descriptions that refer
to daemon-only tools live in those tools' own files, so nothing references a tool that may be
absent.

### 4.5 A minimal config for non-daemon users

The same `fleet.config.json` file serves both audiences at two strictness levels. A user who
only files tickets writes:

```json
{
  "projects": [
    { "name": "fleet", "githubRepo": "owner/fleet", "agents": ["codex"] }
  ]
}
```

- The MCP and `fleet init` parse it with `ProjectsOnlyConfigSchema` (name, githubRepo, and
  the optional `agents` list). Everything else is ignored.
- The daemon parses it with the full `FleetConfigSchema` and rejects it, with a message that
  says which daemon fields are missing. That is correct: this file describes projects, not a
  daemon.

One file format, one discovery rule, two consumers. `FLEET_REPO` stays as an override for a
one-off session but is no longer the primary path for the no-daemon user. The daemon user's
config already contains a superset of these fields, so nothing is duplicated when they later
add a daemon: they extend the same file.

## 5. Phases

Each phase ships on its own and leaves `pnpm typecheck && pnpm test` green.

**Phase 0 (done): consolidate the filing contract.** Move `CreateTicketSchema`,
`labelsForNewTicket`, `bodyWithDependsOn` from `server/server.ts` to
`shared/src/ticket-intake.ts`, tests with them. The REST handler imports them. Worth doing on
its own.

**Phase 1 (done): extract `@fleet/github`.** New workspace package. Move `exec.ts` and the issue and
label helpers with their colocated tests. Declare `typecheck` and `test` scripts in its
`package.json` and add it to daemon's and mcp's dependencies so turbo's `^typecheck` chain
includes it (CLAUDE.md: a package missing those scripts breaks the cache chain silently). No
call site outside `daemon/src/github/` changes.

**Phase 2 (done): restructure the MCP.** Add `resolve.ts`, `ProjectsOnlyConfigSchema`, split
`index.ts` into `tools/*.ts`, rename `client.ts` to `daemon.ts` and remove its two ticket
functions. Register daemon tools conditionally. Tests: resolution table above as a unit test;
a registration test asserting the tool list with and without `daemonUrl`.

**Phase 3 (done): GitHub-backed ticket tools.** Implement `tickets.ts`. Tests mock `run()` the way
`github.test.ts` does and assert argv, labels, and that lint rejection happens before any
`gh` call. Manual check added to the verify skill: `FLEET_REPO=<sandbox repo> pnpm mcp`, file
one ticket from Claude Code or Codex, confirm the daemon claims it unchanged on its next
cycle.

**Phase 4 (done): docs and template.** README and CLAUDE.md gain the "MCP without a daemon"
recipe. `templates/mcp.json.example` gains a commented `FLEET_REPO`-only variant.

**Phase 5 (done): stamp projects for Claude and Codex.** Depends on phases 1 and 2.

- Config gains `agents: ("claude" | "codex")[]`, allowed per project and daemon-wide, default
  `["claude"]` so existing setups are unchanged. Per the `config-shape-change` skill this
  touches `config.ts`, `fleet.config.example.json`, and the example-config test together.
- `sync-templates` becomes a loop over agents with one small stamper each, all fed from the
  same `templates/fleet-backlog/SKILL.md`:

  | Agent | Skill destination | MCP registration |
  |---|---|---|
  | claude | `.claude/skills/fleet-backlog/SKILL.md` | `.mcp.json` (today's merge logic) |
  | codex | `.agents/skills/fleet-backlog/SKILL.md` | `[mcp_servers.fleet]` table in `.codex/config.toml` |

  The TOML stamper preserves existing tables the way `syncMcpJson` preserves existing JSON
  keys. Codex only loads project config from directories the user has marked trusted, so the
  stamper prints a one-line reminder. The skill file is copied verbatim; Codex ignores the
  Claude-only frontmatter fields and the current skill uses none of them. Symlinking one
  location to the other was rejected: Windows checkouts turn symlinks into text files.
- The stamped MCP entry for both agents carries `FLEET_PROJECT` and `FLEET_DIR` as today.
  With the phase 2 resolution, that works with or without a daemon.
- A standalone entry point, `pnpm fleet init` in the mcp package (or a root script), stamps
  the same files without the daemon: it reads the minimal config from section 4.5, or takes
  `--repo owner/name --agents codex` and writes that minimal config for the user first. It
  shares the stampers with `sync-templates`; the only difference is where the project list
  comes from. Issue forms (`.github/ISSUE_TEMPLATE`) stay daemon-side, since they are
  generated from `fleet.yaml` types and are not needed to file a ticket.
- Tests: one per stamper asserting the written file, plus a merge test for the TOML path
  mirroring the existing `.mcp.json` merge test.

## 6. Out of scope, on purpose

- A label-derived board summary for no-daemon users. Possible later as a GitHub-backed
  `fleet_board_status` variant; the one-home-per-tool rule would then need a decision, so it
  is its own discussion.
- The worker runtime abstraction (Claude vs Codex workers). Independent.
- Any MCP reading of `fleet.db`. The daemon stays the only reader.

## 7. Decisions taken in this draft

- Ticket tools always go direct to GitHub, even when a daemon is available.
- `@fleet/github` is a new package, not part of `@fleet/shared`.
- Labels are created lazily on first use.
- Direct-mode backlog lists open issues only, matching what the daemon board shows.
- Daemon tools are registered whenever a daemon URL resolves, not probed at boot.

## 8. Files touched, by phase

| Phase | Adds | Moves or edits |
|---|---|---|
| 0 | `shared/src/ticket-intake.ts` | `daemon/src/server/server.ts` |
| 1 | `packages/github/*` | `daemon/src/github/exec.ts`, `github.ts` (subset), `pnpm-workspace.yaml`, package.json deps |
| 2 | `mcp/src/resolve.ts`, `mcp/src/tools/*`, `shared/src/config.ts` (new schema) | `mcp/src/index.ts`, `client.ts` to `daemon.ts` |
| 3 | `mcp/src/tickets.ts` + test | verify skill |
| 4 | | README, CLAUDE.md, `templates/mcp.json.example` |
| 5 | `daemon/src/sync/{claude,codex}.ts` (stampers), `mcp/src/init.ts`, `templates/codex-config.toml.example` | `sync-templates.ts`, `shared/src/config.ts` (`agents`), `fleet.config.example.json` |
