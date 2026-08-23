import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_ENVIRONMENT_KEYS = ["PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "TMPDIR"] as const;
const READ_ONLY_GIT_CONFIG = [
  "core.quotePath=false",
  "core.fsmonitor=false",
  "diff.external=",
  "core.askPass=",
  "core.editor=",
  "core.sshCommand=",
  "credential.helper=",
  "credential.interactive=false"
] as const;
const DENIED_TRANSPORT_CONFIG = [
  "protocol.allow=never",
  "protocol.file.allow=never",
  "protocol.git.allow=never",
  "protocol.http.allow=never",
  "protocol.https.allow=never",
  "protocol.ssh.allow=never",
  "protocol.ext.allow=never"
] as const;
const LOCAL_FILE_TRANSPORT_CONFIG = [
  "protocol.allow=never",
  "protocol.file.allow=always",
  "protocol.git.allow=never",
  "protocol.http.allow=never",
  "protocol.https.allow=never",
  "protocol.ssh.allow=never",
  "protocol.ext.allow=never"
] as const;

export type GitExecOptions = {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly allowLocalFileTransport?: true;
};

export type GitExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitExec = (args: string[], options: GitExecOptions) => Promise<GitExecResult>;

type GitOutput = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
};

export type GitProcess = {
  readonly stdout: GitOutput;
  readonly stderr: GitOutput;
  kill(): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
};

export type GitSpawnOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: ["ignore", "pipe", "pipe"];
};

export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: GitSpawnOptions
) => GitProcess;

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
 * checkout. The process receives only runtime variables needed to find and run
 * Git, so application secrets and ambient Git configuration cannot leak into
 * repository-controlled helpers. Repository configuration remains available
 * for discovery, but command-level settings disable helper execution.
 */
export function createGitExec(spawnGit: GitSpawn, ambientEnv: NodeJS.ProcessEnv = process.env): GitExec {
  return (args, options) => new Promise<GitExecResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of RUNTIME_ENVIRONMENT_KEYS) {
      const value = ambientEnv[key] ?? Object.entries(ambientEnv)
        .find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_NO_LAZY_FETCH = "1";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";

    const transportConfig = options.allowLocalFileTransport === true
      ? LOCAL_FILE_TRANSPORT_CONFIG
      : DENIED_TRANSPORT_CONFIG;
    const fullArgs = [
      "--no-pager",
      ...[...READ_ONLY_GIT_CONFIG, ...transportConfig].flatMap((config) => ["-c", config]),
      ...args
    ];
    const child = spawnGit("git", fullArgs, {
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
}

const defaultGitSpawn: GitSpawn = (command, args, options) => spawn(command, args, options);

export const execGit = createGitExec(defaultGitSpawn);

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
