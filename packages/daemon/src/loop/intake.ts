import { FLEET_LABELS, lintIntakeBody, PLAN_LABEL, SECTION_LABELS, type ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { swapLabel, upsertStatusComment, type ReadyIssue } from "../github/github.ts";
import { log, logError } from "../log.ts";

export { lintIntakeBody, SECTION_LABELS };
export type { IntakeSection } from "@fleet/shared";

/**
 * The claim-path gate: filters `issues` down to those whose body clears
 * `lintIntakeBody`. A rejected issue is never claimed — instead it gets a
 * status comment naming exactly what's missing and an immediate
 * `fleet:ready` → `fleet:needs-input` swap, run before `processTicket` ever
 * gets a chance to swap the label to `fleet:in-progress`. The body is read
 * fresh off `issues` (not cached), so re-adding `fleet:ready` after fixing it
 * re-lints cleanly next cycle. `project.intakeLint === false` is a full
 * bypass, restoring pre-lint behavior.
 */
export async function applyIntakeLint(ctx: LoopContext, project: ProjectConfig, issues: ReadyIssue[]): Promise<ReadyIssue[]> {
  if (project.intakeLint === false) return issues;

  const passing: ReadyIssue[] = [];
  for (const issue of issues) {
    const missing = lintIntakeBody(issue.body, { isPlan: issue.labels.includes(PLAN_LABEL) });
    if (missing.length === 0) {
      passing.push(issue);
      continue;
    }

    const scope = key(project.name, issue.number);
    const missingList = missing.map((section) => SECTION_LABELS[section]).join(", ");
    if (ctx.dryRun) {
      log("loop", `[dry-run] would flag ${scope} as needs-input: intake lint missing ${missingList}`);
      continue;
    }

    try {
      await upsertStatusComment(
        project,
        issue.number,
        [
          `**Status: needs input**`,
          `Intake lint failed — missing required section(s): ${missingList}.`,
          'Add a heading for each (e.g. `## Problem`, `## Acceptance criteria`, `## Verification` — see the "Fleet task" issue form) and re-add `fleet:ready` to retry.',
        ].join("\n\n"),
      );
    } catch (err) {
      logError("loop", `${scope}: could not post the intake-lint status comment`, err);
    }
    await swapLabel(project, issue.number, FLEET_LABELS.ready, FLEET_LABELS.needsInput);
    log("loop", `${scope}: intake lint failed — missing ${missingList} — moved to fleet:needs-input`);
  }
  return passing;
}
