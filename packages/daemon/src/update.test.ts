import { describe, expect, it, vi } from "vitest";
import { parseUpdateArgs, performUpdate } from "./update.ts";

describe("parseUpdateArgs", () => {
  it("defaults to no drain", () => {
    expect(parseUpdateArgs([])).toEqual({ drain: false });
  });

  it("picks up --drain", () => {
    expect(parseUpdateArgs(["--drain"])).toEqual({ drain: true });
  });

  it("picks up --drain alongside other args", () => {
    expect(parseUpdateArgs(["--config", "other.json", "--drain"])).toEqual({ drain: true });
  });
});

describe("performUpdate", () => {
  const okFetch = () => Promise.resolve(new Response(JSON.stringify({ ok: true, mode: "now" }), { status: 200 }));

  it("pulls, installs, and requests a now-mode restart by default", async () => {
    const runShell = vi.fn().mockResolvedValue({ stdout: "Already up to date.", stderr: "" });
    const fetchImpl = vi.fn(okFetch);

    const exitCode = await performUpdate("/repo", 4400, false, { runShell, fetchImpl });

    expect(exitCode).toBe(0);
    expect(runShell).toHaveBeenNthCalledWith(1, "git pull --ff-only", "/repo");
    expect(runShell).toHaveBeenNthCalledWith(2, "pnpm install", "/repo");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4400/api/daemon/restart",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "now" }) }),
    );
  });

  it("requests a drain-mode restart when drain is set", async () => {
    const runShell = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const fetchImpl = vi.fn(okFetch);

    const exitCode = await performUpdate("/repo", 4400, true, { runShell, fetchImpl });

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4400/api/daemon/restart",
      expect.objectContaining({ body: JSON.stringify({ mode: "drain" }) }),
    );
  });

  it("aborts before installing when git pull --ff-only fails (diverged/dirty tree)", async () => {
    const runShell = vi.fn().mockRejectedValue(new Error("git pull --ff-only failed (exit 128): fatal: Not possible to fast-forward"));
    const fetchImpl = vi.fn(okFetch);

    const exitCode = await performUpdate("/repo", 4400, false, { runShell, fetchImpl });

    expect(exitCode).toBe(1);
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts after a failed pnpm install without requesting a restart", async () => {
    const runShell = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "Already up to date.", stderr: "" })
      .mockRejectedValueOnce(new Error("pnpm install failed (exit 1): boom"));
    const fetchImpl = vi.fn(okFetch);

    const exitCode = await performUpdate("/repo", 4400, false, { runShell, fetchImpl });

    expect(exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a refused connection as a successful update with the daemon simply not running", async () => {
    const runShell = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:4400"));

    const exitCode = await performUpdate("/repo", 4400, false, { runShell, fetchImpl });

    expect(exitCode).toBe(0);
  });

  it("fails when the restart request is rejected (e.g. a shutdown already in flight)", async () => {
    const runShell = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "shutdown already in progress" }), { status: 409 }));

    const exitCode = await performUpdate("/repo", 4400, false, { runShell, fetchImpl });

    expect(exitCode).toBe(1);
  });
});
