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
 * wiring and the dashboard's file-a-ticket form share identical logic.
 */
export function lintIntakeBody(body: string, opts: { isPlan: boolean }): IntakeSection[] {
  const headings = headingTexts(body ?? "");
  const required: IntakeSection[] = opts.isPlan ? ["problem"] : ["problem", "acceptance", "verification"];
  return required.filter((section) => !SECTION_SYNONYMS[section].some((syn) => headings.some((h) => h.includes(syn))));
}
