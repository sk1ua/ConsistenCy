import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export type GitExecOptions = {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
};

export type GitExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitExec = (args: string[], options: GitExecOptions) => Promise<GitExecResult>;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/**
 * Runs git with stdout captured.
 *
 * `GIT_OPTIONAL_LOCKS=0` is the load-bearing flag: without it, read commands
 * refresh and lock the index, which fights a developer running git in the same
 * checkout. Ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE are stripped so no
 * inherited environment can redirect a command away from `cwd`, and
 * `core.quotePath=false` keeps non-ASCII paths raw instead of octal-escaped.
 */
export const execGit: GitExec = (args, options) => new Promise<GitExecResult>((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";

  const fullArgs = ["--no-pager", "-c", "core.quotePath=false", ...args];
  const child = spawn("git", fullArgs, {
    cwd: options.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let overflowed = false;

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxBytes) {
      overflowed = true;
      child.kill();
      return;
    }
    stdoutChunks.push(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    finish(() => reject(new GitCommandError(
      `Failed to start git: ${error.message}`,
      fullArgs,
      null,
      stderr
    )));
  });

  child.on("close", (code) => {
    finish(() => {
      if (overflowed) {
        reject(new GitCommandError(
          `git output exceeded ${maxBytes} bytes`,
          fullArgs,
          code,
          stderr
        ));
        return;
      }
      if (timedOut) {
        reject(new GitCommandError(
          `git timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
          fullArgs,
          code,
          stderr
        ));
        return;
      }
      if (code !== 0) {
        reject(new GitCommandError(
          `git exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
          fullArgs,
          code,
          stderr
        ));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        exitCode: code ?? 0
      });
    });
  });
});

/**
 * Validates a single revision before it is placed on an argv line. `shell:false`
 * already rules out shell injection, so this guards the remaining risks: a
 * leading `-` turning a ref into an option, `..` silently widening a single
 * revision into a range, and `:` turning it into a `rev:path` spec.
 *
 * Revision suffixes callers legitimately use (`HEAD~1`, `main^`, `HEAD@{1}`)
 * are allowed.
 */
export function assertSafeRef(ref: string): string {
  const value = ref.trim();
  if (value.length === 0) throw new Error("Ref must not be empty");
  if (value.length > 255) throw new Error("Ref is unreasonably long");
  if (value.startsWith("-")) throw new Error(`Ref must not start with '-': ${ref}`);
  if (value.includes("..")) throw new Error(`Ref must be a single revision, not a range: ${ref}`);
  if (value.includes(":")) throw new Error(`Ref must not contain ':': ${ref}`);
  if (/[\x00-\x20\x7f\\?*[\]]/.test(value)) {
    throw new Error(`Ref contains characters git does not allow: ${ref}`);
  }
  return value;
}
