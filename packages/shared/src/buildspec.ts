import { z } from "zod";
import { FLEET_TYPE_LABEL_PREFIX } from "./labels.ts";

export const BuildSpecStepSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  /** When true, a non-zero exit is logged and swallowed instead of failing the claim — for warm-the-cache steps where a red baseline on main must not block worktree creation. */
  allowFailure: z.boolean().optional(),
});
export type BuildSpecStep = z.infer<typeof BuildSpecStepSchema>;

/** Same vocabulary as the `fleet:elevate`/`fleet:light` labels, plus `"default"` for "no override — fall through to the project's `model`". */
export const TierSchema = z.enum(["light", "default", "elevated"]);
export type Tier = z.infer<typeof TierSchema>;

/**
 * A profile is either the original bare step array, or an object that can
 * also carry keys beyond setup — `teardown:`, steps run best-effort when the
 * worktree is discarded (for releasing per-worktree resources `setup:`
 * provisioned; absent means nothing new runs anywhere), `contract:`, the
 * markdown appended to the worker's system contract for tickets of this
 * type, `review:`, the checklist markdown appended to the machine reviewer's
 * prompt for tickets of this type, `verify:`, the list of commands the
 * worker must run before finishing `completed` (and the reviewer checks for
 * evidence of), and `tier:`, this type's default model tier. Later per-type
 * siblings get their own optional keys here without another schema
 * migration.
 */
const ProfileSchema = z.union([
  z.array(BuildSpecStepSchema),
  z.object({
    setup: z.array(BuildSpecStepSchema),
    teardown: z.array(BuildSpecStepSchema).optional(),
    contract: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
    verify: z.array(z.string().min(1)).optional(),
    tier: TierSchema.optional(),
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
function normalizeProfile(
  profile: Profile,
): { steps: BuildSpecStep[]; teardown?: BuildSpecStep[]; contract?: string; review?: string; verify?: string[]; tier?: Tier } {
  if (Array.isArray(profile)) return { steps: profile };
  return {
    steps: profile.setup,
    teardown: profile.teardown,
    contract: profile.contract,
    review: profile.review,
    verify: profile.verify,
    tier: profile.tier,
  };
}

/** Profile names a repo's `fleet.yaml` declares (map form only; `default` excluded since it never gets its own label). */
export function profileNames(spec: BuildSpec): string[] {
  if (Array.isArray(spec.setup)) return [];
  return Object.keys(spec.setup).filter((name) => name !== "default");
}

export interface SetupSelection {
  profile: string;
  steps: BuildSpecStep[];
  /** The selected profile's declared `teardown:` steps, if any — unlike the type-keyed extras below, the `default` profile's teardown applies to untyped tickets too, since its setup is what provisioned for them. */
  teardown?: BuildSpecStep[];
  /** The `fleet:type:<name>` actually matched to a profile — undefined for list-form specs, no type label, or an unmatched one (the "default" fallback doesn't count as a type). */
  type?: string;
  /** The matched type's declared `contract:` markdown, if any — only ever set alongside `type`. */
  contract?: string;
  /** The matched type's declared `review:` checklist markdown, if any — only ever set alongside `type`. */
  review?: string;
  /** The matched type's declared `verify:` commands, if any — only ever set alongside `type`. */
  verify?: string[];
  /** The matched type's declared `tier:`, if any — only ever set alongside `type`; `"default"` and unset are equivalent (no override). */
  tier?: Tier;
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
  const defaultProfile = normalizeProfile(profiles.default ?? []);
  const defaultSteps = defaultProfile.steps;
  const typeNames = [
    ...new Set(
      labels
        .filter((label) => label.startsWith(FLEET_TYPE_LABEL_PREFIX))
        .map((label) => label.slice(FLEET_TYPE_LABEL_PREFIX.length)),
    ),
  ].sort();

  if (typeNames.length === 0) {
    return { profile: "default", steps: defaultSteps, teardown: defaultProfile.teardown };
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
    teardown: matchedProfile ? matchedProfile.teardown : defaultProfile.teardown,
    type: matched,
    contract: matchedProfile?.contract,
    review: matchedProfile?.review,
    verify: matchedProfile?.verify,
    tier: matchedProfile?.tier,
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
 * The teardown steps for a ticket of `type`, looked up directly by name —
 * how the daemon re-derives at worktree-removal time what
 * `selectSetupProfile` selected at claim time. Unlike the other per-type
 * lookups, an undefined or unknown type falls back to the `default`
 * profile's teardown (mirroring the setup fallback that provisioned for it).
 * Undefined for list-form specs or when the resolved profile declares no
 * `teardown:`.
 */
export function teardownForType(spec: BuildSpec, type: string | undefined): BuildSpecStep[] | undefined {
  if (Array.isArray(spec.setup)) return undefined;
  const profile = (type ? spec.setup[type] : undefined) ?? spec.setup.default;
  return profile ? normalizeProfile(profile).teardown : undefined;
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

/**
 * A type's declared `verify:` commands, looked up directly by name — same
 * re-derivation path as `contractForType`/`checklistForType`, used both by
 * the worker (told to run them before finishing `completed`) and the machine
 * reviewer (told to check the diff/evidence for whether they ran). Undefined
 * for list-form specs, an unknown type name, or a profile that declares no
 * `verify:`.
 */
export function verifyForType(spec: BuildSpec, type: string | undefined): string[] | undefined {
  if (!type || Array.isArray(spec.setup)) return undefined;
  const profile = spec.setup[type];
  return profile ? normalizeProfile(profile).verify : undefined;
}

/**
 * A type's declared `tier:`, looked up directly by name — same
 * re-derivation path as `contractForType`/`checklistForType`, used to
 * re-resolve a resumed session's model tier from just the type name
 * `TicketRecord.ticketType` already carries. Undefined for list-form specs,
 * an unknown type name, or a profile that declares no `tier:` (including
 * an explicit `tier: default`, which is the same as unset).
 */
export function tierForType(spec: BuildSpec, type: string | undefined): Tier | undefined {
  if (!type || Array.isArray(spec.setup)) return undefined;
  const profile = spec.setup[type];
  const tier = profile ? normalizeProfile(profile).tier : undefined;
  return tier === "default" ? undefined : tier;
}
