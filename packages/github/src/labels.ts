import { ALL_FLEET_LABELS, typeLabel } from "@fleet/shared";
import { run } from "./exec.ts";
import type { RepoRef } from "./issues.ts";

/** Creates (or refreshes, via `--force`) every global `fleet:*` label. Idempotent. */
export async function ensureFleetLabels(repo: RepoRef): Promise<void> {
  for (const label of ALL_FLEET_LABELS) {
    await run("gh", [
      "label", "create", label.name,
      "--repo", repo.githubRepo,
      "--color", label.color,
      "--description", label.description,
      "--force",
    ]);
  }
}

/** Per-repo `fleet:type:<name>` label for one fleet.yaml setup profile. */
export async function ensureTypeLabel(repo: RepoRef, name: string): Promise<void> {
  await run("gh", [
    "label", "create", typeLabel(name),
    "--repo", repo.githubRepo,
    "--color", "c5def5",
    "--description", `Route this ticket to the "${name}" fleet.yaml setup profile`,
    "--force",
  ]);
}
