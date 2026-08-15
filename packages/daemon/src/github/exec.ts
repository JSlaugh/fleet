import { exec, execFile } from "node:child_process";

export interface RunOptions {
  allowFailure?: boolean;
}

export interface RunResult {
  stdout: string;
  /** Only meaningful when `allowFailure` was set — a rejected call never resolves, so its stderr lives in the thrown Error instead. */
  stderr: string;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !options.allowFailure) {
          const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((error as unknown as { code: number }).code)
            : 1;
          reject(new Error(`${command} ${args.join(" ")} failed (exit ${exitCode}): ${stderr || stdout || error.message}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

export async function runJson<T>(command: string, args: string[], options: RunOptions = {}): Promise<T> {
  const { stdout } = await run(command, args, options);
  return JSON.parse(stdout) as T;
}

export function runShell(command: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed (exit ${error.code ?? 1}): ${stderr || stdout || error.message}`));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}
