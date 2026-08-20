import { lintIntakeBody, SECTION_LABELS, type IntakeSection } from "@fleet/shared";

export interface TicketFormSections {
  problem: string;
  acceptance: string;
  verification: string;
}

const SECTION_ORDER: IntakeSection[] = ["problem", "acceptance", "verification"];

/**
 * Builds the issue body from the form's three sections, omitting any section
 * left blank — so a blank section reads as genuinely missing to
 * `lintIntakeBody` rather than as a heading with no content underneath it.
 */
export function composeTicketBody(sections: TicketFormSections): string {
  return SECTION_ORDER.map((section) => {
    const content = sections[section].trim();
    return content ? `## ${SECTION_LABELS[section]}\n\n${content}` : null;
  })
    .filter((s): s is string => s !== null)
    .join("\n\n");
}

/** Same gate the claim path runs (`lintIntakeBody` from `@fleet/shared`), so a malformed ticket fails at the desk. */
export function missingTicketSections(sections: TicketFormSections): IntakeSection[] {
  return lintIntakeBody(composeTicketBody(sections), { isPlan: false });
}
