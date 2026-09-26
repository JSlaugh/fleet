import { ALL_FLEET_LABELS, typeLabel } from "@fleet/shared";
import { run, runJson } from "./exec.ts";
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

/**
 * Creates any fleet label the repo lacks, leaving existing ones untouched —
 * one `gh label list` plus a create per missing label, so it's cheap enough to
 * run at every daemon boot. Without it, a label added in a fleet upgrade (e.g.
 * `fleet:backlog`) makes `gh issue create --label` fail until someone
 * remembers `init-labels`. Returns the labels it created.
 */
export async function ensureMissingLabels(repo: RepoRef): Promise<string[]> {
  const existing = await runJson<{ name: string }[]>("gh", ["label", "list", "--repo", repo.githubRepo, "--json", "name", "--limit", "500"]);
  const have = new Set(existing.map((l) => l.name));
  const created: string[] = [];
  for (const label of ALL_FLEET_LABELS) {
    if (have.has(label.name)) continue;
    await run("gh", ["label", "create", label.name, "--repo", repo.githubRepo, "--color", label.color, "--description", label.description]);
    created.push(label.name);
  }
  return created;
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
