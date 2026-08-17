import { FLEET_LABELS, PLAN_LABEL, type ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { closeIssue, parseChildTaskList, upsertStatusComment, type ReadyIssue } from "../github/github.ts";
import { log, logError } from "../log.ts";

/**
 * Whether an epic's children are all closed and it should be closed too.
 * "Closed" means not in `openIssueNumbers` — a child closed without merging
 * (abandoned) counts the same as a merged one, so an abandoned sibling can't
 * wedge the epic open forever. An epic with no filed children yet never
 * qualifies (nothing to be "all closed" over).
 */
export function epicCloseDecision(
  children: { number: number }[],
  openIssueNumbers: ReadonlySet<number>,
): { shouldClose: boolean; closedCount: number; totalCount: number } {
  const totalCount = children.length;
  const closedCount = children.filter((c) => !openIssueNumbers.has(c.number)).length;
  return { shouldClose: totalCount > 0 && closedCount === totalCount, closedCount, totalCount };
}

/**
 * Each cycle, closes any `fleet:review` plan epic whose filed children
 * (`## Children` task list, stamped on the epic body by `finishPlanned`) are
 * all closed — merged or abandoned alike. An epic still `fleet:plan`+running,
 * blocked, or with any open child is left untouched; a human closes it
 * manually if they want it done early. `cleanupFinished` (`board.ts`) archives
 * the ticket record on a later cycle once it sees the issue itself is closed,
 * same as it already does for a human-closed epic.
 */
export async function closeFinishedEpics(
  ctx: LoopContext,
  project: ProjectConfig,
  issues: ReadyIssue[],
  openIssueNumbers: ReadonlySet<number>,
): Promise<void> {
  for (const issue of issues) {
    if (!issue.labels.includes(PLAN_LABEL)) continue;
    if (!issue.labels.includes(FLEET_LABELS.review)) continue;

    const children = parseChildTaskList(issue.body);
    const { shouldClose, closedCount, totalCount } = epicCloseDecision(children, openIssueNumbers);
    if (!shouldClose) continue;

    const scope = key(project.name, issue.number);
    try {
      await upsertStatusComment(
        project,
        issue.number,
        `**Status: complete** — all ${totalCount} child ticket${totalCount === 1 ? "" : "s"} are closed (merged or abandoned).`,
      );
    } catch (err) {
      logError("loop", `${scope}: could not post the epic-closed status comment`, err);
    }
    try {
      await closeIssue(project, issue.number);
      log("loop", `${scope}: all ${closedCount}/${totalCount} child ticket(s) closed — closing epic`);
    } catch (err) {
      logError("loop", `${scope}: could not close the epic issue`, err);
    }
  }
}
