import { z } from "zod";
import { FLEET_TYPE_LABEL_PREFIX } from "./labels.ts";

export const BuildSpecStepSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
});
export type BuildSpecStep = z.infer<typeof BuildSpecStepSchema>;

const SetupProfilesSchema = z
  .record(z.string(), z.array(BuildSpecStepSchema))
  .refine((profiles) => "default" in profiles, {
    message: 'setup profiles must include a "default" profile',
  });

export const BuildSpecSchema = z.object({
  setup: z.union([z.array(BuildSpecStepSchema), SetupProfilesSchema]),
});
export type BuildSpec = z.infer<typeof BuildSpecSchema>;

/** Profile names a repo's `fleet.yaml` declares (map form only; `default` excluded since it never gets its own label). */
export function profileNames(spec: BuildSpec): string[] {
  if (Array.isArray(spec.setup)) return [];
  return Object.keys(spec.setup).filter((name) => name !== "default");
}

export interface SetupSelection {
  profile: string;
  steps: BuildSpecStep[];
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
  const defaultSteps = profiles.default ?? [];
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

  return {
    profile: matched ?? "default",
    steps: matched ? (profiles[matched] ?? defaultSteps) : defaultSteps,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}
