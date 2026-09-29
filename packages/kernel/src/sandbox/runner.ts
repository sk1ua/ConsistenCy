/**
 * SandboxRunner — the ONLY place that spawns child processes.
 *
 * Spawns `worker-bootstrap.mjs` with `child_process.fork`:
 *   - transport: Node parent/child IPC channel (protocol only),
 *   - stdio: stdin ignored, stdout ignored, stderr piped (diagnostics only),
 *   - execArgv: empty (the child must not inherit parent loader flags),
 *   - env: explicit allowlist ONLY (see env.ts) — never process.env.
 *
 * The worker bootstrap is resolved relative to this module so the sandbox
 * works from source checkouts without a build step.
 */

import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildSandboxEnvironment } from "./env.js";
import { SandboxLaunchError } from "./errors.js";

const WORKER_BOOTSTRAP_URL = new URL("./worker/worker-bootstrap.mjs", import.meta.url);
const WORKER_BOOTSTRAP_PATH = fileURLToPath(WORKER_BOOTSTRAP_URL);

export interface SandboxChildProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  send(message: Serializable): boolean;
  kill(): void;
  disconnect(): void;
}

export interface SandboxSpawnOptions {
  readonly entrypoint: string;
  /** Extra allowlisted env vars (test-only). Never the parent environment. */
  readonly envExtension?: Readonly<Record<string, string | undefined>>;
  /** Extra argv entries after the entrypoint (test fixtures only). */
  readonly workerArgs?: readonly string[];
}

/**
 * Fork the sandbox worker for one plugin entrypoint.
 *
 * @throws {SandboxLaunchError} when the bootstrap is missing or fork throws.
 */
export function spawnSandboxChild(options: SandboxSpawnOptions): SandboxChildProcess {
  if (!existsSync(WORKER_BOOTSTRAP_PATH)) {
    throw new SandboxLaunchError(
      `sandbox worker bootstrap not found at ${WORKER_BOOTSTRAP_PATH}`,
    );
  }
  if (!options.entrypoint) {
    throw new SandboxLaunchError("plugin entrypoint path is empty");
  }

  const env = buildSandboxEnvironment(options.envExtension);

  let child: ChildProcess;
  try {
    child = fork(WORKER_BOOTSTRAP_PATH, [options.entrypoint, ...(options.workerArgs ?? [])], {
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
    });
  } catch (error) {
    throw new SandboxLaunchError(
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    child,
    pid: child.pid,
    send: (message: Serializable) => child.send(message),
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    },
    disconnect: () => {
      try {
        child.disconnect();
      } catch {
        /* channel already closed */
      }
    },
  };
}
