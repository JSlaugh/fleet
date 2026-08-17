import { FLEET_LABELS, PLAN_LABEL, type ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { swapLabel, upsertStatusComment, type ReadyIssue } from "../github/github.ts";
import { log, logError } from "../log.ts";

export type IntakeSection = "problem" | "acceptance" | "verification";

/** Tolerant synonyms per required section — matched as a substring of a heading's lowercased text. */
const SECTION_SYNONYMS: Record<IntakeSection, readonly string[]> = {
  problem: ["problem", "summary", "context", "background"],
  acceptance: ["acceptance criteria", "acceptance", "requirements", "done when", "task"],
  verification: ["verification", "verify", "test plan", "testing"],
};

export const SECTION_LABELS: Record<IntakeSection, string> = {
  problem: "Problem",
  acceptance: "Acceptance criteria",
  verification: "Verification",
};

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;

function headingTexts(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => HEADING_LINE.exec(line)?.[1]?.toLowerCase())
    .filter((h): h is string => Boolean(h));
}

/**
 * Which required sections are missing from an issue body — matched
 * tolerantly against a markdown heading at any level (`#` through `######`),
 * case-insensitively, with synonyms (`SECTION_SYNONYMS`). A `fleet:plan`
 * epic only needs a problem statement; acceptance criteria and verification
 * legitimately don't exist yet before decomposition. Pure, so the claim-path
 * wiring and this module's exhaustive tests exercise identical logic.
 */
export function lintIntakeBody(body: string, opts: { isPlan: boolean }): IntakeSection[] {
  const headings = headingTexts(body ?? "");
  const required: IntakeSection[] = opts.isPlan ? ["problem"] : ["problem", "acceptance", "verification"];
  return required.filter((section) => !SECTION_SYNONYMS[section].some((syn) => headings.some((h) => h.includes(syn))));
}

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
