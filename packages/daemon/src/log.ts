const SHADOWED_WARNING_CODE = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";

/**
 * The Agent SDK (0.3.x) emits a CLAUDE_SDK_CAN_USE_TOOL_SHADOWED process
 * warning on every `query()` whose bare `allowedTools` entries bypass
 * `canUseTool`. Here that shadowing IS the design: the allowlist keeps routine
 * tools off the ApprovalManager, and the forbidden git/gh surface is enforced
 * by the PreToolUse hook in `session/worker.ts` instead — so the warning is
 * noise repeated once per worker and review session. Filter exactly that code;
 * every other warning still reaches Node's default stderr printer.
 */
export function suppressCanUseToolShadowedWarning(): void {
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    // Two overloads: (warning, { code, ... }) or (warning, type?, code?, ctor?).
    const [first, second] = rest;
    const code = first !== null && typeof first === "object" ? (first as { code?: unknown }).code : second;
    if (code === SHADOWED_WARNING_CODE) return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}

export function log(scope: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${scope}] ${message}`);
}

export function logError(scope: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? ` — ${err.message}` : err !== undefined ? ` — ${String(err)}` : "";
  console.error(`[${new Date().toISOString()}] [${scope}] ERROR: ${message}${detail}`);
}
