import { spawn } from "node:child_process";
import { FrameyardError, type FrameyardErrorCode } from "../errors.js";

const TAIL_LIMIT = 64 * 1024;

export interface RunChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to the child's stdin before it is closed. */
  stdin?: string;
  signal?: AbortSignal;
  /** Forward child stdout/stderr to this process's stderr. Defaults to true. */
  forwardOutput?: boolean;
  /** Error code used for spawn/exit failures. */
  errorCode?: FrameyardErrorCode;
  /** Human label used in error messages. */
  label?: string;
  /** Actionable hint included when the executable cannot be found. */
  executableHint?: string;
  /** Resolve even when the child exits nonzero (for probing --help/--version). */
  allowFailure?: boolean;
}

export interface RunChildResult {
  stdout: string;
  stderr: string;
  code: number;
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length > TAIL_LIMIT ? next.slice(-TAIL_LIMIT) : next;
}

/**
 * Runs one external integration process, captures its output tail, and
 * terminates it when the operation is cancelled.
 */
export function runChild(
  command: string,
  args: string[],
  options: RunChildOptions = {},
): Promise<RunChildResult> {
  const errorCode = options.errorCode ?? "INTERNAL";
  const label = options.label ?? command;

  if (options.signal?.aborted) {
    return Promise.reject(new FrameyardError("CANCELLED", "Operation cancelled."));
  }

  return new Promise<RunChildResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new FrameyardError(errorCode, `Could not start ${label}: ${(error as Error).message}`, {
          cause: error,
        }),
      );
      return;
    }

    const onAbort = (): void => {
      child.kill("SIGKILL");
      finish(() => reject(new FrameyardError("CANCELLED", "Operation cancelled.")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
      if (options.forwardOutput !== false) {
        process.stderr.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
      if (options.forwardOutput !== false) {
        process.stderr.write(chunk);
      }
    });
    // A failed child may close stdin while input is still being written.
    child.stdin?.on("error", () => undefined);

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        const hint = options.executableHint ? ` ${options.executableHint}` : "";
        finish(() =>
          reject(
            new FrameyardError(
              "EXECUTABLE_NOT_FOUND",
              `Executable not found: ${command}.${hint}`,
              { cause: error },
            ),
          ),
        );
        return;
      }
      finish(() =>
        reject(
          new FrameyardError(errorCode, `Could not start ${label}: ${error.message}`, {
            cause: error,
          }),
        ),
      );
    });

    child.once("close", (code, closeSignal) => {
      const exitCode = code ?? -1;
      if (options.signal?.aborted) {
        finish(() => reject(new FrameyardError("CANCELLED", "Operation cancelled.")));
        return;
      }
      if (exitCode !== 0) {
        const detail = stderr.trim();
        if (options.allowFailure === true) {
          finish(() => resolve({ stdout, stderr, code: exitCode }));
          return;
        }
        finish(() =>
          reject(
            new FrameyardError(
              errorCode,
              `${label} exited with ${code === null ? `signal ${closeSignal ?? "unknown"}` : `code ${code}`}${detail ? `:\n${detail}` : "."}`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve({ stdout, stderr, code: exitCode }));
    });

    child.stdin?.end(options.stdin ?? "");
  });
}
