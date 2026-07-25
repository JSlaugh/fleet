import { exec, execFile } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  allowFailure?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? ((error as unknown as { code: number }).code)
          : error
            ? 1
            : 0;
        if (error && !options.allowFailure) {
          reject(new Error(`${command} ${args.join(" ")} failed (exit ${exitCode}): ${stderr || stdout || error.message}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode });
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
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 });
    });
  });
}
