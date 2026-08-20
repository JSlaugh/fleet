import type { LoopContext } from "./context.ts";
import { log } from "../log.ts";

/**
 * Operator-initiated active/dormant pin toggle for the board redesign
 * (#152) — purely a dashboard display concern, distinct from `setProjectPaused`
 * in `pause.ts`: a dormant project keeps claiming/resuming/polling exactly as
 * before, it just collapses to a rollup row on the board until pinned back.
 */
export function setProjectDormant(ctx: LoopContext, projectName: string, dormant: boolean): void {
  ctx.state.setProjectDormant(projectName, dormant);
  log("loop", dormant ? `${projectName}: pinned dormant on the board` : `${projectName}: pinned active on the board`);
  ctx.emitBoard();
}
