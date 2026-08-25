import { Octokit } from "@octokit/rest";
import type { GitHubConnectionTestResponse } from "@consistency/schema";
import type { GitHubAppAuthenticator } from "./auth";
import { classifyGitHubApiError, toGitHubApiError, type GitHubApiError } from "./client";

/** Single bounded outbound probe: hard ceiling per test click, no retries. */
const PROBE_TIMEOUT_MS = 8_000;

export interface GitHubConnectionTestInput {
  readonly publicReadToken?: string;
  readonly appAuthenticator?: GitHubAppAuthenticator;
  readonly publicPrAnalysisEnabled: boolean;
  readonly signal?: AbortSignal;
}

/**
 * All network seams are injectable so unit tests never touch the network.
 * Default implementations use the existing @octokit/rest dependency and the
 * shared GitHub error classification kernel.
 */
export interface GitHubConnectionTestDeps {
  fetchImpl?: typeof fetch;
  probeToken?: (token: string, signal?: AbortSignal) => Promise<void>;
  probeAnonymous?: (signal?: AbortSignal) => Promise<void>;
  probeApp?: (authenticator: GitHubAppAuthenticator, signal?: AbortSignal) => Promise<boolean>;
  now?: () => Date;
}

function probeSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function computeRetryAfterMs(error: GitHubApiError, nowMs: number): number | undefined {
  const retryAfter = error.retryAfter;
  if (retryAfter !== undefined && retryAfter.trim() !== "") {
    if (/^\d+$/.test(retryAfter)) return Math.max(1, Number(retryAfter) * 1_000);
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) return Math.max(1, parsed - nowMs);
  }
  const reset = error.rateLimitReset;
  if (reset !== undefined && /^\d+$/.test(reset)) {
    return Math.max(1, Number(reset) * 1_000 - nowMs);
  }
  return undefined;
}

function rateLimitedResult(error: GitHubApiError, nowMs: number, testedAt: string): GitHubConnectionTestResponse {
  const retryAfterMs = computeRetryAfterMs(error, nowMs);
  return { status: "rate_limited", ...(retryAfterMs === undefined ? {} : { retryAfterMs }), testedAt };
}

/**
 * Truthful single-probe connection test for the ACTIVE runtime credential
 * (process configuration at boot — never unsaved Settings drafts).
 *
 * Priority order mirrors the read-access truth: public-read PAT, then the
 * GitHub App JWT, then one anonymous GET /rate_limit. Exactly one outbound
 * call is made per invocation (anonymous quota is a shared 60/hr budget).
 * A configured non-empty public-read PAT is probed regardless of the
 * public-PR-analysis flag — the active credential stays truthful even when
 * analysis is disabled; not_configured is returned only when the PAT is
 * empty AND no app authenticator exists AND public PR analysis is disabled.
 * The result carries status enums and bounded retry metadata only; tokens,
 * raw URLs, and filesystem paths never appear in any path.
 */
export async function testGitHubConnection(
  input: GitHubConnectionTestInput,
  deps: GitHubConnectionTestDeps = {}
): Promise<GitHubConnectionTestResponse> {
  try {
    return await runSingleProbe(input, deps);
  } catch {
    // Fail closed to a sanitized status; never surface raw error text.
    const testedAt = (deps.now ?? (() => new Date()))().toISOString();
    return { status: "unavailable", testedAt };
  }
}

async function runSingleProbe(
  input: GitHubConnectionTestInput,
  deps: GitHubConnectionTestDeps
): Promise<GitHubConnectionTestResponse> {
  const now = deps.now ?? (() => new Date());
  const testedAtDate = now();
  const testedAt = testedAtDate.toISOString();

  if (
    (input.publicReadToken === undefined || input.publicReadToken === "")
    && input.appAuthenticator === undefined
    && !input.publicPrAnalysisEnabled
  ) {
    return { status: "not_configured", testedAt };
  }

  const probeToken = deps.probeToken ?? ((token, signal) => rateLimitCall(deps, token, signal));
  const probeAnonymous = deps.probeAnonymous ?? (signal => rateLimitCall(deps, undefined, signal));
  const probeApp = deps.probeApp ?? ((authenticator, signal) => authenticator.verifyAppCredentials(probeSignal(signal)));

  if (input.publicReadToken !== undefined && input.publicReadToken !== "") {
    try {
      await probeToken(input.publicReadToken, input.signal);
      return { status: "connected", mode: "pat", testedAt };
    } catch (error) {
      const apiError = toGitHubApiError(error);
      const failure = classifyGitHubApiError(apiError);
      if (failure === "rate_limited") return rateLimitedResult(apiError, testedAtDate.getTime(), testedAt);
      if (failure === "access_denied") return { status: "invalid_credential", testedAt };
      return { status: "unavailable", testedAt };
    }
  }

  if (input.appAuthenticator !== undefined) {
    try {
      const verified = await probeApp(input.appAuthenticator, input.signal);
      return verified
        ? { status: "connected", mode: "app", testedAt }
        : { status: "invalid_credential", testedAt };
    } catch (error) {
      const apiError = toGitHubApiError(error);
      const failure = classifyGitHubApiError(apiError);
      if (failure === "rate_limited") return rateLimitedResult(apiError, testedAtDate.getTime(), testedAt);
      if (failure === "access_denied") return { status: "invalid_credential", testedAt };
      return { status: "unavailable", testedAt };
    }
  }

  try {
    await probeAnonymous(input.signal);
    return { status: "anonymous_available", mode: "anonymous", testedAt };
  } catch (error) {
    const apiError = toGitHubApiError(error);
    if (classifyGitHubApiError(apiError) === "rate_limited") {
      return rateLimitedResult(apiError, testedAtDate.getTime(), testedAt);
    }
    return { status: "unavailable", testedAt };
  }
}

/**
 * Default read-only probe: one GET /rate_limit request (200 → resolve,
 * anything else → normalized GitHubApiError through the shared kernel).
 */
async function rateLimitCall(
  deps: GitHubConnectionTestDeps,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const octokit = new Octokit({
    ...(token === undefined ? {} : { auth: token }),
    ...(deps.fetchImpl === undefined ? {} : { request: { fetch: deps.fetchImpl } })
  });
  try {
    await octokit.rest.rateLimit.get({ request: { signal: probeSignal(signal) } });
  } catch (error) {
    throw toGitHubApiError(error);
  }
}
