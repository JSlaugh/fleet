// Process spawning lives in @fleet/github now (the MCP server needs it too);
// this shim keeps the daemon's `./exec.ts` import and mock paths unchanged.
export { run, runJson, runJsonPaginated, runShell, type RunOptions, type RunResult } from "@fleet/github";
