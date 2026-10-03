/**
 * CLI-side configuration resolution.
 *
 * Two different roots matter and are deliberately kept apart:
 *   - the `--repo` path: the checkout being reviewed (read-only input);
 *   - the install root: where ConsistenCy's own settings, `.env`, and generated
 *     artifacts live.
 * The API daemon derives both from one process CWD, which is not true for a CLI
 * that is told to review an arbitrary directory, so they are resolved here.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig } from "@consistency/api/config/runtime";
import type { AppConfig } from "@consistency/api/config/env";
import { SettingsStore, findProjectRoot } from "@consistency/api/config/settings";
import { defaultPythonPath } from "@consistency/api/config/env";
import type { ReviewOptions } from "./args";

/** Walk up from this module to the workspace root (`name: consistency-workspace`). */
export function installRoot(startDirectory?: string): string {
  return findProjectRoot(startDirectory ?? dirname(fileURLToPath(import.meta.url)));
}

export type CliConfig = {
  config: AppConfig;
  store: SettingsStore;
  root: string;
};

/**
 * Loads settings exactly the way the daemon does (settings file, then `.env`,
 * then process env) but anchored at the install root rather than the caller's
 * CWD, so `consistency review --repo ../other` still reads the same settings.
 */
export function loadCliConfig(root = installRoot()): CliConfig {
  const store = new SettingsStore(root);
  const previous = process.cwd();
  try {
    if (previous !== root) process.chdir(root);
    const loaded = loadRuntimeConfig(store);
    return { config: loaded.config, store: loaded.store ?? store, root };
  } finally {
    if (process.cwd() !== previous) process.chdir(previous);
  }
}

/**
 * The Python interpreter for the deterministic engine.
 *
 * `defaultPythonPath()` returns a bare `python` on Windows, which resolves to
 * whatever is first on PATH — on this host that is Python 3.13, not the 3.12 the
 * engine requires. An explicit `CONSISTENCY_PYTHON_PATH` always wins; otherwise
 * a repo-local virtualenv is preferred over PATH, because it is the only
 * interpreter whose version the project actually controls.
 */
export function resolvePythonPath(config: AppConfig, root: string): string {
  const configured = config.CONSISTENCY_PYTHON_PATH?.trim();
  if (configured !== undefined && configured !== "" && configured !== defaultPythonPath()) {
    return configured;
  }
  const venv = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python3");
  if (existsSync(venv)) return venv;
  return configured !== undefined && configured !== "" ? configured : defaultPythonPath();
}

/** `python -m engine` only resolves with the repo root as CWD. */
export function resolveEngineRoot(config: AppConfig, root: string): string {
  return config.engineRoot ?? resolve(root);
}

/**
 * Opt out before any knowledge path or Python memory hook is handed to the
 * runtime. The flag always disables memory; only the exact env value "1" does.
 * This is a CLI policy, not engine environment (which remains allowlisted).
 */
/** Exact env value "1" enables lean review. Every other value stays full. */
export function resolveLeanEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_LEAN === "1";
}

/** Exact env value "1" opts into the maintainer reviewer; the workload also requires lean. */
export function resolveLeanReviewer(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_LEAN_REVIEWER === "1";
}

/** Exact env value "1" records withheld findings. Every other value omits the field. */
export function resolveReportWithheld(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_REPORT_WITHHELD === "1";
}

/** Exact env value "1" enables the v2 scoring rubric. */
export function resolveScoreRubricV2(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_SCORE_RUBRIC === "1";
}

/** Exact env value "1" replaces full file context with numbered hunks and units. */
export function resolveCompactContext(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_COMPACT_CONTEXT === "1";
}

/** Exact env value "1" tightens lean Consistency. Every other value stays unchanged. */
export function resolveLeanConsistencyStrict(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_LEAN_CONSISTENCY_STRICT === "1";
}

/** Exact env value "1" keeps distinct cross-agent claims in lean reviews. */
export function resolveLeanStrictMerge(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CONSISTENCY_LEAN_STRICT_MERGE === "1";
}

export function resolveMemoryEnabled(
  options: Pick<ReviewOptions, "noMemory">,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return options.noMemory !== true && environment.CONSISTENCY_NO_MEMORY !== "1";
}

/**
 * Where the review writes its generated state. Kept under the install root's
 * `.consistency/` (which is gitignored) rather than inside the reviewed
 * checkout, so reviewing someone else's repository never writes into it.
 */
export function cliArtifactRoot(config: AppConfig, root: string): string {
  return join(root, ".consistency", "cli");
}
