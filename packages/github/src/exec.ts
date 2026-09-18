import { exec, execFile } from "node:child_process";

export interface RunOptions {
  allowFailure?: boolean;
  /** Piped to the child's stdin — the path for large payloads (GitHub bodies) that would overflow the Windows ~32K command-line limit as argv. */
  stdin?: string;
}

export interface RunResult {
  stdout: string;
  /** Only meaningful when `allowFailure` was set — a rejected call never resolves, so its stderr lives in the thrown Error instead. */
  stderr: string;
}

/** Args echoed into error messages, capped so a failed call carrying a large payload doesn't dump it into the log. */
function describeArgs(args: string[]): string {
  const joined = args.join(" ");
  return joined.length > 400 ? `${joined.slice(0, 400)}… (${joined.length} chars)` : joined;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !options.allowFailure) {
          const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((error as unknown as { code: number }).code)
            : 1;
          reject(new Error(`${command} ${describeArgs(args)} failed (exit ${exitCode}): ${stderr || stdout || error.message}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when the child exits before reading — the callback above reports the real failure
      child.stdin.end(options.stdin);
    }
  });
}

export async function runJson<T>(command: string, args: string[], options: RunOptions = {}): Promise<T> {
  const { stdout } = await run(command, args, options);
  return JSON.parse(stdout) as T;
}

/**
 * `gh api` over a list endpoint, fetching every page. Plain `--paginate`
 * concatenates each page's JSON array back to back — unparseable past one page
 * — so this uses `--slurp` (gh ≥ 2.40), which wraps the pages into one outer
 * array, then flattens. Use this instead of `runJson` for any `gh api` call
 * that returns an array.
 */
export async function runJsonPaginated<T>(command: string, args: string[], options: RunOptions = {}): Promise<T[]> {
  const pages = await runJson<T[][]>(command, [...args, "--paginate", "--slurp"], options);
  return pages.flat();
}

export function runShell(command: string, cwd: string, env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `env` REPLACES the child's environment, so extras are layered over the
    // daemon's own — a bare extras object would strip PATH out from under the step.
    const childEnv = env ? { ...process.env, ...env } : undefined;
    exec(command, { cwd, env: childEnv, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed (exit ${error.code ?? 1}): ${stderr || stdout || error.message}`));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}
