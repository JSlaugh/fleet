import type { DigestResponse, NotificationsConfig } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "./test-support.ts";
import { buildDigestMessage, buildNotificationMessage, issueUrl, notify, postDigest, projectUrl, shouldNotify, type NotifyDetail } from "./notify.ts";

const project = makeProject();

const detail: NotifyDetail = {
  issueNumber: 7,
  title: "Fix the thing",
  detail: "need the API key",
  url: "https://github.com/acme/alpha/issues/7",
};

describe("shouldNotify", () => {
  it("is false with no config", () => {
    expect(shouldNotify(undefined, "pr-opened")).toBe(false);
  });

  it("is true for every event when events is unset", () => {
    const config: NotificationsConfig = { discordUrl: "https://discord.example/webhook" };
    expect(shouldNotify(config, "failed")).toBe(true);
    expect(shouldNotify(config, "auto-merged")).toBe(true);
  });

  it("filters to only the configured events", () => {
    const config: NotificationsConfig = { discordUrl: "https://discord.example/webhook", events: ["failed"] };
    expect(shouldNotify(config, "failed")).toBe(true);
    expect(shouldNotify(config, "pr-opened")).toBe(false);
  });
});

describe("buildNotificationMessage", () => {
  it("includes the event label, project#issue, title, detail, and link", () => {
    const message = buildNotificationMessage("needs-input", project, detail);

    expect(message).toContain("Needs input");
    expect(message).toContain("alpha#7 Fix the thing");
    expect(message).toContain("need the API key");
    expect(message).toContain("https://github.com/acme/alpha/issues/7");
  });

  it("omits an empty detail line", () => {
    const message = buildNotificationMessage("pr-opened", project, { ...detail, detail: "" });

    expect(message.split("\n")).toHaveLength(2);
  });

  it("labels every event distinctly", () => {
    const events = ["needs-input", "pr-opened", "failed", "paused", "auto-merged", "stale-released"] as const;
    const labels = events.map((event) => buildNotificationMessage(event, project, detail).split("\n")[0]);
    expect(new Set(labels).size).toBe(events.length);
  });

  it("scopes to just the project, with no #N, for a project-wide event with no triggering issue", () => {
    const message = buildNotificationMessage("paused", project, {
      title: "Budget gate",
      detail: "window spend $10.00 >= budget $10.00 — holding all claims",
      url: "https://github.com/acme/alpha",
    });

    expect(message).toContain("alpha Budget gate");
    expect(message).not.toContain("alpha#");
  });
});

describe("issueUrl", () => {
  it("builds a github issue link from githubRepo", () => {
    expect(issueUrl(project, 7)).toBe("https://github.com/acme/alpha/issues/7");
  });
});

describe("projectUrl", () => {
  it("builds a github repo link from githubRepo", () => {
    expect(projectUrl(project)).toBe("https://github.com/acme/alpha");
  });
});

describe("notify", () => {
  const config: NotificationsConfig = { discordUrl: "https://discord.example/webhook" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without notifications configured", async () => {
    await notify({ config: {}, dryRun: false, once: false }, "needs-input", project, detail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing under --dry-run", async () => {
    await notify({ config: { notifications: config }, dryRun: true, once: false }, "needs-input", project, detail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing under --once", async () => {
    await notify({ config: { notifications: config }, dryRun: false, once: true }, "needs-input", project, detail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing when the event is filtered out by events", async () => {
    const filtered: NotificationsConfig = { ...config, events: ["failed"] };
    await notify({ config: { notifications: filtered }, dryRun: false, once: false }, "needs-input", project, detail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the built message to the webhook, bounded by a timeout signal", async () => {
    await notify({ config: { notifications: config }, dryRun: false, once: false }, "needs-input", project, detail);

    expect(fetch).toHaveBeenCalledWith("https://discord.example/webhook", expect.objectContaining({ method: "POST" }));
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("Needs input");
    // An unresponsive host must never hang the awaiting ticket path indefinitely.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("treats an aborted (timed-out) request the same as any other rejection — logged, never thrown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "TimeoutError");
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(notify({ config: { notifications: config }, dryRun: false, once: false }, "needs-input", project, detail)).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it("logs once and resolves cleanly when fetch rejects — never affects the ticket path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(notify({ config: { notifications: config }, dryRun: false, once: false }, "needs-input", project, detail)).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it("logs once and resolves cleanly on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(notify({ config: { notifications: config }, dryRun: false, once: false }, "needs-input", project, detail)).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});

function emptyDigest(patch: Partial<DigestResponse> = {}): DigestResponse {
  return { windowHours: 24, since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z", projects: [], totalSpendUsd: 0, gateHolds: [], ...patch };
}

describe("buildDigestMessage", () => {
  it("says nothing happened when every project is empty and there are no gate holds", () => {
    expect(buildDigestMessage(emptyDigest())).toBe("**Daily digest** — trailing 24h\nNothing happened.");
  });

  it("summarizes each non-empty bucket per project", () => {
    const message = buildDigestMessage(
      emptyDigest({
        projects: [
          {
            project: "alpha",
            completed: [{ project: "alpha", issueNumber: 1, title: "t", url: "u" }],
            autoMerged: [{ project: "alpha", issueNumber: 2, title: "t", url: "u" }],
            blocked: [{ project: "alpha", issueNumber: 3, title: "t", url: "u" }],
            failed: [{ project: "alpha", issueNumber: 4, title: "t", url: "u" }],
            staleReleases: [{ project: "alpha", issueNumber: 5, title: "t", url: "u", owners: ["bob"], at: "2026-01-01T00:00:00.000Z" }],
            spendUsd: 1,
          },
        ],
      }),
    );
    expect(message).toContain("**alpha**");
    expect(message).toContain("1 completed, awaiting review");
    expect(message).toContain("1 auto-merged");
    expect(message).toContain("1 blocked");
    expect(message).toContain("1 failed");
    expect(message).toContain("1 stale claim(s) released");
  });

  it("omits an empty project entirely", () => {
    const message = buildDigestMessage(
      emptyDigest({ projects: [{ project: "alpha", completed: [], autoMerged: [], blocked: [], failed: [], staleReleases: [], spendUsd: 0 }] }),
    );
    expect(message).not.toContain("alpha");
  });

  it("includes gate holds and spend vs budget when present", () => {
    const message = buildDigestMessage(
      emptyDigest({ gateHolds: [{ gate: "budget", at: "2026-01-01T00:00:00.000Z", detail: "held" }], totalSpendUsd: 4, budget: { budgetUsd: 10, windowHours: 5 } }),
    );
    expect(message).toContain("1 claim-gate hold(s)");
    expect(message).toContain("Spend: $4.00 / $10.00 (5h)");
  });
});

describe("postDigest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without a discordUrl configured", async () => {
    await postDigest({ config: {}, dryRun: false, once: false }, emptyDigest());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing under --dry-run or --once", async () => {
    const config: NotificationsConfig = { discordUrl: "https://discord.example/webhook" };
    await postDigest({ config: { notifications: config }, dryRun: true, once: false }, emptyDigest());
    await postDigest({ config: { notifications: config }, dryRun: false, once: true }, emptyDigest());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the built message to the webhook", async () => {
    const config: NotificationsConfig = { discordUrl: "https://discord.example/webhook" };
    await postDigest({ config: { notifications: config }, dryRun: false, once: false }, emptyDigest());

    expect(fetch).toHaveBeenCalledWith("https://discord.example/webhook", expect.objectContaining({ method: "POST" }));
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("Daily digest");
  });

  it("logs once and resolves cleanly on a webhook failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const config: NotificationsConfig = { discordUrl: "https://discord.example/webhook" };
    await expect(postDigest({ config: { notifications: config }, dryRun: false, once: false }, emptyDigest())).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});
