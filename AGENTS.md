# AGENTS.md

Guidance for Codex (and any other agent that reads `AGENTS.md`) working in this repository.

**Read [`CLAUDE.md`](CLAUDE.md) before doing anything else, and follow it.** It is the single source of truth for this repo — what fleet is, the commands, the architecture, the state model and the conventions — and it applies to every agent, not just Claude Code. It is kept in one place so the two never drift; don't copy its content here.

Codex-specific notes:

- Repo skills live in `.agents/skills/` (copies of `.claude/skills/`, which are canonical — change a skill there and copy it across).
- The `fleet` MCP server is registered in `.codex/config.toml`, which Codex loads only when this directory is trusted. The registration is machine-neutral: it runs `.fleet-mcp/launch.mjs`, which reads this checkout's gitignored `fleet.config.json`.
- Before declaring a change done, run the verification in `.agents/skills/verify/SKILL.md` (`pnpm typecheck`, `pnpm test`, and a `pnpm daemon -- --dry-run --once` cycle for daemon changes).
