import { describe, expect, it } from "vitest";
import { run, runJson, runShell } from "./exec.ts";

describe("run", () => {
  it("resolves with stdout on success", async () => {
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(stdout).toBe("hi");
  });

  it("rejects with the numeric exit code when the process exits non-zero", async () => {
    await expect(run(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow(/exit 3/);
  });

  it("falls back to exit 1 when the subprocess error's code is a string, not the real exit code", async () => {
    // A spawn failure (e.g. ENOENT) sets error.code to a string like "ENOENT", not
    // a numeric exit code — run() must not print that string as if it were one.
    await expect(run("fleet-nonexistent-command-xyz", [])).rejects.toThrow(/exit 1/);
  });

  it("includes stderr in the rejection message when present", async () => {
    await expect(
      run(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(2)"]),
    ).rejects.toThrow(/boom/);
  });

  it("resolves instead of rejecting when allowFailure is set, even on non-zero exit", async () => {
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write('partial'); process.exit(1)"], {
      allowFailure: true,
    });
    expect(stdout).toBe("partial");
  });
});

describe("runJson", () => {
  it("parses JSON stdout", async () => {
    const result = await runJson<{ ok: boolean }>(process.execPath, ["-e", "process.stdout.write('{\"ok\":true}')"]);
    expect(result).toEqual({ ok: true });
  });
});

describe("runShell", () => {
  it("resolves with stdout on success", async () => {
    const { stdout } = await runShell(`${JSON.stringify(process.execPath)} -e "process.stdout.write('hi')"`, process.cwd());
    expect(stdout).toBe("hi");
  });

  it("runs the command in the given cwd", async () => {
    const { stdout } = await runShell(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`,
      process.cwd(),
    );
    expect(stdout).toBe(process.cwd());
  });

  it("rejects with the exit code and stderr when the command fails", async () => {
    await expect(
      runShell(`${JSON.stringify(process.execPath)} -e "process.stderr.write('bad'); process.exit(4)"`, process.cwd()),
    ).rejects.toThrow(/exit 4.*bad|bad.*exit 4/s);
  });

  it("interprets shell metacharacters, unlike run/execFile", async () => {
    // runShell goes through a real shell — this is a contract test documenting that
    // callers are responsible for not passing untrusted input into the command string.
    const { stdout } = await runShell(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write('a')" && ${JSON.stringify(process.execPath)} -e "process.stdout.write('b')"`,
      process.cwd(),
    );
    expect(stdout).toBe("ab");
  });
});
