/**
 * Least-privilege environment for sandbox child processes.
 *
 * The child is NEVER launched with the parent's `process.env`. Instead it
 * receives an explicit platform allowlist containing only runtime variables
 * required for the Node process itself:
 *
 *   win32 : SystemRoot, windir, COMSPEC, PATHEXT, TEMP, TMP
 *   posix : PATH, TMPDIR, LANG, LC_ALL, LC_CTYPE
 *
 * Explicitly EXCLUDED (never inherited, never allowed):
 *   GitHub tokens, LLM API keys, database credentials, SSH credentials,
 *   cloud credentials, CI secrets, NODE_OPTIONS, and any harness-specific
 *   session variables.
 *
 * PLATFORM NOTE: on Windows the operating system itself injects default
 * values for SystemRoot/PATH and a few other SYSTEM-level variables into
 * every process regardless of the environment block we pass. That is OS
 * behaviour, not parent inheritance — PARENT-SPECIFIC secrets are still
 * absent (verified by test). Full OS-level environment containment is
 * platform-specific and out of scope for the sandbox subsystem.
 */

const WINDOWS_ALLOWLIST = ["SystemRoot", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP"] as const;
const POSIX_ALLOWLIST = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

/**
 * Build the child environment from the allowlist ONLY, plus an optional
 * explicit extension (used for test-only variables). Values are copied
 * per-variable; the parent environment object is never passed through.
 */
export function buildSandboxEnvironment(
  extension?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const names: readonly string[] = process.platform === "win32" ? WINDOWS_ALLOWLIST : POSIX_ALLOWLIST;
  const env: Record<string, string> = {};

  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }

  for (const [key, value] of Object.entries(extension ?? {})) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Names of credential classes the sandbox must never receive. Used by tests
 * and diagnostics to scan for accidental leakage; not a runtime gate.
 */
export const CREDENTIAL_ENV_HINTS: readonly string[] = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "API_KEY",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "AUTH",
  "SSH",
  "GITHUB",
  "OPENAI",
  "ANTHROPIC",
  "DATABASE_URL",
];
