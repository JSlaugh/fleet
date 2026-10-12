import type { Tier } from "@fleet/shared";

/**
 * Which model a ticket's session should run on, most specific wins:
 * `fleet:elevate`/`fleet:light` labels (elevate wins when both are present —
 * elevation is an escalation signal) beat the ticket's `fleet.yaml` type's
 * declared `tier:`, which in turn beats the project default. Every tier
 * falls through to the project default when its matching tier model isn't
 * configured. Kept dependency-free (re-exported from `runner.ts`) so the
 * preflight gate (`authGate.ts`) can enumerate the same resolution without
 * importing the session runner.
 */
export function selectModel(
  project: { model?: string; elevatedModel?: string; lightModel?: string },
  opts: { elevated: boolean; light: boolean; typeTier?: Tier },
): string | undefined {
  if (opts.elevated) return project.elevatedModel ?? project.model;
  if (opts.light) return project.lightModel ?? project.model;
  if (opts.typeTier === "elevated") return project.elevatedModel ?? project.model;
  if (opts.typeTier === "light") return project.lightModel ?? project.model;
  return project.model;
}
