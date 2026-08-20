import { z } from "zod";
import { FLEET_TYPE_LABEL_PREFIX } from "./labels.ts";

export const BuildSpecStepSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
});
export type BuildSpecStep = z.infer<typeof BuildSpecStepSchema>;

/**
 * A profile is either the original bare step array, or an object that can
 * also carry keys beyond setup — `contract:`, the markdown appended to the
 * worker's system contract for tickets of this type, and `review:`, the
 * checklist markdown appended to the machine reviewer's prompt for tickets of
 * this type. Later per-type siblings (model tier, verify commands) get their
 * own optional keys here without another schema migration.
 */
const ProfileSchema = z.union([
  z.array(BuildSpecStepSchema),
  z.object({
    setup: z.array(BuildSpecStepSchema),
    contract: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
  }),
]);
export type Profile = z.infer<typeof ProfileSchema>;

const SetupProfilesSchema = z
  .record(z.string(), ProfileSchema)
  .refine((profiles) => "default" in profiles, {
    message: 'setup profiles must include a "default" profile',
  });

export const BuildSpecSchema = z.object({
  setup: z.union([z.array(BuildSpecStepSchema), SetupProfilesSchema]),
});
export type BuildSpec = z.infer<typeof BuildSpecSchema>;

/** A profile's steps and (map-object form only) its declared extra keys. */
function normalizeProfile(profile: Profile): { steps: BuildSpecStep[]; contract?: string; review?: string } {
  if (Array.isArray(profile)) return { steps: profile };
  return { steps: profile.setup, contract: profile.contract, review: profile.review };
}

/** Profile names a repo's `fleet.yaml` declares (map form only; `default` excluded since it never gets its own label). */
export function profileNames(spec: BuildSpec): string[] {
  if (Array.isArray(spec.setup)) return [];
  return Object.keys(spec.setup).filter((name) => name !== "default");
}

export interface SetupSelection {
  profile: string;
  steps: BuildSpecStep[];
  /** The `fleet:type:<name>` actually matched to a profile — undefined for list-form specs, no type label, or an unmatched one (the "default" fallback doesn't count as a type). */
  type?: string;
  /** The matched type's declared `contract:` markdown, if any — only ever set alongside `type`. */
  contract?: string;
  /** The matched type's declared `review:` checklist markdown, if any — only ever set alongside `type`. */
  review?: string;
  warning?: string;
}

/**
 * Picks which setup profile a claim should run. List-form specs have exactly
 * one (implicit `default`) profile and ignore labels entirely. Map-form specs
 * match against `fleet:type:<name>` labels, sorted for determinism when more
 * than one is present; no match (or no type label at all) falls back to
 * `default`. Every fallback/ambiguity case is surfaced via `warning` rather
 * than failing the claim — an unknown or duplicated type label is a config
 * hygiene issue, not a reason to block work.
 */
export function selectSetupProfile(spec: BuildSpec, labels: string[]): SetupSelection {
  if (Array.isArray(spec.setup)) {
    return { profile: "default", steps: spec.setup };
  }

  const profiles = spec.setup;
  // Schema validation (`SetupProfilesSchema`'s refine) guarantees a "default"
  // key exists; the `?? []` here is only to satisfy noUncheckedIndexedAccess.
  const defaultSteps = normalizeProfile(profiles.default ?? []).steps;
  const typeNames = [
    ...new Set(
      labels
        .filter((label) => label.startsWith(FLEET_TYPE_LABEL_PREFIX))
        .map((label) => label.slice(FLEET_TYPE_LABEL_PREFIX.length)),
    ),
  ].sort();

  if (typeNames.length === 0) {
    return { profile: "default", steps: defaultSteps };
  }

  const matched = typeNames.find((name) => profiles[name]);
  const warnings: string[] = [];
  if (typeNames.length > 1) {
    warnings.push(`multiple fleet:type:* labels (${typeNames.join(", ")}) — using "${matched ?? typeNames[0]}"`);
  }
  if (!matched) {
    warnings.push(`no setup profile named "${typeNames[0]}" in fleet.yaml — using "default"`);
  }

  const matchedProfile = matched ? normalizeProfile(profiles[matched] ?? profiles.default ?? []) : undefined;

  return {
    profile: matched ?? "default",
    steps: matchedProfile ? matchedProfile.steps : defaultSteps,
    type: matched,
    contract: matchedProfile?.contract,
    review: matchedProfile?.review,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

/**
 * A type's declared `contract:` markdown, looked up directly by name rather
 * than through label matching — how a resumed session re-derives the same
 * appendix `selectSetupProfile` attached at claim time, from just the type
 * name `TicketRecord.ticketType` already carries. Undefined for list-form
 * specs, an unknown type name, or a profile that declares no `contract:`.
 */
export function contractForType(spec: BuildSpec, type: string | undefined): string | undefined {
  if (!type || Array.isArray(spec.setup)) return undefined;
  const profile = spec.setup[type];
  return profile ? normalizeProfile(profile).contract : undefined;
}

/**
 * A type's declared `review:` checklist markdown, looked up directly by name
 * — same re-derivation path as `contractForType`, used by the machine
 * reviewer to append type-specific dimensions to its generic pass. Undefined
 * for list-form specs, an unknown type name, or a profile that declares no
 * `review:`.
 */
export function checklistForType(spec: BuildSpec, type: string | undefined): string | undefined {
  if (!type || Array.isArray(spec.setup)) return undefined;
  const profile = spec.setup[type];
  return profile ? normalizeProfile(profile).review : undefined;
}
