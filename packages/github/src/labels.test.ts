import { ALL_FLEET_LABELS } from "@fleet/shared";
import { beforeEach, expect, describe, it, vi } from "vitest";

vi.mock("./exec.ts", async (importActual) => ({
  ...(await importActual<typeof import("./exec.ts")>()),
  run: vi.fn(),
  runJson: vi.fn(),
}));

const exec = await import("./exec.ts");
const { ensureMissingLabels } = await import("./labels.ts");

const repo = { githubRepo: "acme/alpha" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureMissingLabels", () => {
  it("creates only the fleet labels the repo lacks, leaving existing ones untouched", async () => {
    vi.mocked(exec.runJson).mockResolvedValueOnce(ALL_FLEET_LABELS.filter((l) => l.name !== "fleet:backlog").map((l) => ({ name: l.name })));
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "" });

    const created = await ensureMissingLabels(repo);

    expect(created).toEqual(["fleet:backlog"]);
    expect(exec.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exec.run).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["label", "create", "fleet:backlog"]));
  });

  it("creates nothing when every label exists", async () => {
    vi.mocked(exec.runJson).mockResolvedValueOnce(ALL_FLEET_LABELS.map((l) => ({ name: l.name })));
    expect(await ensureMissingLabels(repo)).toEqual([]);
    expect(exec.run).not.toHaveBeenCalled();
  });
});
