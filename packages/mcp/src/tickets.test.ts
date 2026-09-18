import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fleet/github", async (importActual) => ({
  ...(await importActual<typeof import("@fleet/github")>()),
  createIssue: vi.fn(),
  ensureFleetLabels: vi.fn(async () => {}),
  listFleetIssues: vi.fn(async () => []),
}));

const github = await import("@fleet/github");
const { GithubTickets, formatBacklogText, intakeProblem, priorityLabel, toCreateTicketInput } = await import("./tickets.ts");

const GOOD_BODY = "## Problem\n\nx\n\n## Acceptance criteria\n\n- y\n\n## Verification\n\nz";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("priorityLabel", () => {
  it("maps the short priority to a fleet: label", () => {
    expect(priorityLabel("p1")).toBe("fleet:p1");
  });

  it("returns undefined when no priority is given", () => {
    expect(priorityLabel(undefined)).toBeUndefined();
  });
});

describe("toCreateTicketInput", () => {
  it("builds a minimal input, defaulting ready to true", () => {
    expect(toCreateTicketInput({ title: "t", body: "b" })).toEqual({ title: "t", body: "b", ready: true });
  });

  it("carries priority, ready and dependsOn through", () => {
    expect(toCreateTicketInput({ title: "t", body: "b", priority: "p2", ready: false, dependsOn: [12] })).toEqual({
      title: "t",
      body: "b",
      priority: "fleet:p2",
      ready: false,
      dependsOn: [12],
    });
  });
});

describe("intakeProblem", () => {
  it("accepts a body with all three sections", () => {
    expect(intakeProblem(toCreateTicketInput({ title: "t", body: GOOD_BODY }))).toBeUndefined();
  });

  it("names the missing sections", () => {
    expect(intakeProblem(toCreateTicketInput({ title: "t", body: "## Problem\n\nx" }))).toMatch(/Acceptance criteria, Verification/);
  });

  it("skips the lint for a curation (ready: false) ticket", () => {
    expect(intakeProblem(toCreateTicketInput({ title: "t", body: "rough idea", ready: false }))).toBeUndefined();
  });
});

describe("GithubTickets.fileTicket", () => {
  it("refuses a malformed ready body before touching gh", async () => {
    const tickets = new GithubTickets("acme/alpha");
    await expect(tickets.fileTicket({ title: "t", body: "no headings" })).rejects.toThrow(/missing required sections/);
    expect(github.ensureFleetLabels).not.toHaveBeenCalled();
    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("ensures labels once, then files with the shared contract's labels and Depends-on line", async () => {
    vi.mocked(github.createIssue).mockResolvedValue({ number: 9, url: "https://github.com/acme/alpha/issues/9" });
    const tickets = new GithubTickets("acme/alpha");

    const first = await tickets.fileTicket({ title: "t", body: GOOD_BODY, priority: "p1", dependsOn: [3] });
    await tickets.fileTicket({ title: "u", body: GOOD_BODY, ready: false });

    expect(first).toEqual({ number: 9, url: "https://github.com/acme/alpha/issues/9" });
    expect(github.ensureFleetLabels).toHaveBeenCalledTimes(1);
    expect(github.ensureFleetLabels).toHaveBeenCalledWith({ githubRepo: "acme/alpha" });
    expect(github.createIssue).toHaveBeenNthCalledWith(1, { githubRepo: "acme/alpha" }, {
      title: "t",
      body: `${GOOD_BODY}\n\nDepends-on: #3`,
      labels: ["fleet:ready", "fleet:p1"],
    });
    expect(github.createIssue).toHaveBeenNthCalledWith(2, { githubRepo: "acme/alpha" }, { title: "u", body: GOOD_BODY, labels: [] });
  });

  it("retries label creation on the next call if it failed", async () => {
    vi.mocked(github.ensureFleetLabels).mockRejectedValueOnce(new Error("gh down"));
    vi.mocked(github.createIssue).mockResolvedValue({ number: 1, url: "u" });
    const tickets = new GithubTickets("acme/alpha");
    await expect(tickets.fileTicket({ title: "t", body: GOOD_BODY })).rejects.toThrow(/gh down/);
    await tickets.fileTicket({ title: "t", body: GOOD_BODY });
    expect(github.ensureFleetLabels).toHaveBeenCalledTimes(2);
  });
});

describe("GithubTickets.queryBacklog", () => {
  it("maps fleet issues to backlog rows and drops ones with no board status", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([
      { number: 1, title: "a", body: "", labels: ["fleet:ready", "fleet:p2"], url: "u1", author: "x", assignees: [] },
      { number: 2, title: "b", body: "", labels: ["fleet:review"], url: "u2", author: "x", assignees: [] },
      { number: 3, title: "c", body: "", labels: ["fleet:light"], url: "u3", author: "x", assignees: [] },
    ]);
    const rows = await new GithubTickets("acme/alpha").queryBacklog();
    expect(rows).toEqual([
      { number: 1, title: "a", status: "ready", priority: "fleet:p2", url: "u1" },
      { number: 2, title: "b", status: "review", priority: null, url: "u2" },
    ]);
  });
});

describe("formatBacklogText", () => {
  it("reports an empty backlog", () => {
    expect(formatBacklogText([])).toBe("Backlog is empty.");
  });

  it("formats each ticket compactly, omitting the priority segment when there is none", () => {
    expect(formatBacklogText([{ number: 12, title: "Add a thing", status: "ready", priority: "fleet:p1", url: "u" }])).toBe("#12 [ready] fleet:p1 Add a thing");
    expect(formatBacklogText([{ number: 12, title: "Add a thing", status: "ready", priority: null, url: "u" }])).toBe("#12 [ready] Add a thing");
  });
});
