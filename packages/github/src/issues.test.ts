import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./exec.ts", async (importActual) => ({
  ...(await importActual<typeof import("./exec.ts")>()),
  run: vi.fn(),
  runJson: vi.fn(),
}));

const exec = await import("./exec.ts");
const { createIssue, issueNumberFromUrl, listFleetIssues, priorityRank } = await import("./issues.ts");

const repo = { githubRepo: "acme/alpha" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("priorityRank", () => {
  it("ranks p1 above p2 above p3", () => {
    expect(priorityRank(["fleet:p1"])).toBeLessThan(priorityRank(["fleet:p2"]));
    expect(priorityRank(["fleet:p2"])).toBeLessThan(priorityRank(["fleet:p3"]));
  });

  it("returns the lowest rank (largest number) when no priority label is present", () => {
    expect(priorityRank(["fleet:ready"])).toBe(3);
    expect(priorityRank([])).toBe(3);
  });

  it("uses the highest priority when several are present", () => {
    expect(priorityRank(["fleet:p3", "fleet:p1"])).toBe(0);
  });
});

describe("issueNumberFromUrl", () => {
  it("takes the last path segment", () => {
    expect(issueNumberFromUrl("https://github.com/acme/alpha/issues/42\n")).toBe(42);
  });

  it("rejects a URL with no numeric tail", () => {
    expect(() => issueNumberFromUrl("https://github.com/acme/alpha/issues/")).toThrow(/could not parse/);
  });
});

describe("createIssue", () => {
  it("passes title, labels and the body over stdin, and parses the number from the printed URL", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: "Creating issue in acme/alpha\nhttps://github.com/acme/alpha/issues/7\n", stderr: "" });
    const result = await createIssue(repo, { title: "T", body: "B", labels: ["fleet:ready", "fleet:p2"] });
    expect(result).toEqual({ number: 7, url: "https://github.com/acme/alpha/issues/7" });
    expect(exec.run).toHaveBeenCalledWith(
      "gh",
      ["issue", "create", "--repo", "acme/alpha", "--title", "T", "--body-file", "-", "--label", "fleet:ready", "--label", "fleet:p2"],
      { stdin: "B" },
    );
  });
});

describe("listFleetIssues", () => {
  it("keeps only fleet-labelled issues, sorted by priority then number", async () => {
    vi.mocked(exec.runJson).mockResolvedValue([
      { number: 3, title: "c", body: "", labels: [{ name: "fleet:ready" }, { name: "fleet:p3" }], url: "u3", author: { login: "a" }, assignees: [] },
      { number: 1, title: "a", body: null, labels: [{ name: "bug" }], url: "u1", author: { login: "a" }, assignees: [] },
      { number: 2, title: "b", body: "", labels: [{ name: "fleet:ready" }, { name: "fleet:p1" }], url: "u2", author: { login: "a" }, assignees: [] },
    ]);
    const issues = await listFleetIssues(repo);
    expect(issues.map((i) => i.number)).toEqual([2, 3]);
  });
});
