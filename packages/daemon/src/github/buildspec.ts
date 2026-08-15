import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BuildSpecSchema, type BuildSpec } from "@fleet/shared";
import { parse } from "yaml";

/**
 * Parses and validates a `fleet.yaml` document. Throws with a message naming
 * the concrete problem (bad YAML vs. schema violation) — callers must never
 * fall back to `setupCommand` on a parse failure, since that would silently
 * mask a broken spec.
 */
export function parseBuildSpec(yamlText: string): BuildSpec {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (err) {
    throw new Error(`fleet.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = BuildSpecSchema.safeParse(doc);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`fleet.yaml is invalid: ${issues.join("; ")}`);
  }
  return result.data;
}

/** `undefined` when the repo has no `fleet.yaml`; throws (via `parseBuildSpec`) when it exists but is malformed. */
export function readBuildSpec(repoRoot: string): BuildSpec | undefined {
  const path = join(repoRoot, "fleet.yaml");
  if (!existsSync(path)) return undefined;
  return parseBuildSpec(readFileSync(path, "utf8"));
}
