/**
 * Exit code `index.ts` uses to signal "restart requested" (as opposed to a
 * clean stop, exit 0, or a crash, any other nonzero code) to the supervisor
 * wrapper (`scripts/fleet-supervisor.mjs`). That script runs as plain Node
 * with no TS/tsx step, so it can't import this constant directly — it
 * hardcodes the same value; keep the two in sync if this ever changes.
 */
export const RESTART_EXIT_CODE = 87;
