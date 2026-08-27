import { describe, expect, it, vi } from "vitest";
import { githubConnectionTestResponseSchema } from "@consistency/schema";
import type { GitHubAppAuthenticator } from "./auth";
import { GitHubApiError, toGitHubApiError } from "./client";
import { testGitHubConnection } from "./connectionTest";

const fixedNow = () => new Date("2026-08-24T00:00:00.000Z");

/** Never touched: every app-network seam is replaced by an injected fake. */
const fakeAuthenticator = {} as GitHubAppAuthenticator;

describe("testGitHubConnection", () => {
  it("reports not_configured without any outbound probe when analysis is disabled and no app exists", async () => {
    const probeToken = vi.fn();
    const probeAnonymous = vi.fn();
    const probeApp = vi.fn();
    const result = await testGitHubConnection(
      { publicPrAnalysisEnabled: false },
      { probeToken, probeAnonymous, probeApp, now: fixedNow }
    );
    expect(result).toEqual({ status: "not_configured", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(probeToken).not.toHaveBeenCalled();
    expect(probeAnonymous).not.toHaveBeenCalled();
    expect(probeApp).not.toHaveBeenCalled();
  });

  it("reports a working public-read PAT as connected in pat mode", async () => {
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      { probeToken: vi.fn(async () => undefined), now: fixedNow }
    );
    expect(result).toEqual({ status: "connected", mode: "pat", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(githubConnectionTestResponseSchema.parse(result)).toEqual(result);
  });

  it("maps a 401 PAT rejection to invalid_credential", async () => {
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 401", 401);
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "invalid_credential", testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("maps rate limiting to rate_limited with bounded retryAfterMs from retry-after seconds", async () => {
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 429", 429, undefined, "30");
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "rate_limited", retryAfterMs: 30_000, testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("parses an IMF-fixdate retry-after header against the injected clock", async () => {
    // The HTTP-date is derived from the injected now (+60s) so the assertion
    // never rots as wall-clock time passes.
    const retryAfterHttpDate = new Date(fixedNow().getTime() + 60_000).toUTCString();
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 429", 429, undefined, retryAfterHttpDate);
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "rate_limited", retryAfterMs: 60_000, testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("derives retryAfterMs from the x-ratelimit-reset epoch against the injected clock", async () => {
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 403", 403, "1787529660", undefined, "0");
        }),
        now: fixedNow
      }
    );
    expect(result.status).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(60_000);
  });

  it("maps network failures and 5xx provider errors to unavailable", async () => {
    const networkFailure = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
        now: fixedNow
      }
    );
    expect(networkFailure).toEqual({ status: "unavailable", testedAt: "2026-08-24T00:00:00.000Z" });

    const serverError = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 502", 502);
        }),
        now: fixedNow
      }
    );
    expect(serverError).toEqual({ status: "unavailable", testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("probes exactly one credential, preferring the PAT over app and anonymous access", async () => {
    const probeToken = vi.fn(async () => undefined);
    const probeApp = vi.fn(async () => true);
    const probeAnonymous = vi.fn(async () => undefined);
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", appAuthenticator: fakeAuthenticator, publicPrAnalysisEnabled: true },
      { probeToken, probeApp, probeAnonymous, now: fixedNow }
    );
    expect(result).toEqual({ status: "connected", mode: "pat", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(probeToken).toHaveBeenCalledTimes(1);
    expect(probeApp).not.toHaveBeenCalled();
    expect(probeAnonymous).not.toHaveBeenCalled();
  });

  it("falls back to the GitHub App credential when no PAT is configured", async () => {
    const verified = await testGitHubConnection(
      { appAuthenticator: fakeAuthenticator, publicPrAnalysisEnabled: true },
      { probeApp: vi.fn(async () => true), now: fixedNow }
    );
    expect(verified).toEqual({ status: "connected", mode: "app", testedAt: "2026-08-24T00:00:00.000Z" });

    const rejected = await testGitHubConnection(
      { appAuthenticator: fakeAuthenticator, publicPrAnalysisEnabled: true },
      { probeApp: vi.fn(async () => false), now: fixedNow }
    );
    expect(rejected).toEqual({ status: "invalid_credential", testedAt: "2026-08-24T00:00:00.000Z" });

    const unavailable = await testGitHubConnection(
      { appAuthenticator: fakeAuthenticator, publicPrAnalysisEnabled: true },
      {
        probeApp: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 503", 503);
        }),
        now: fixedNow
      }
    );
    expect(unavailable).toEqual({ status: "unavailable", testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("maps an app-probe rate limit to rate_limited with retryAfterMs like the PAT branch", async () => {
    const result = await testGitHubConnection(
      { appAuthenticator: fakeAuthenticator, publicPrAnalysisEnabled: true },
      {
        probeApp: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 429", 429, undefined, "30");
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "rate_limited", retryAfterMs: 30_000, testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("maps an app-probe 401 carried by a thrown error to invalid_credential", async () => {
    // verifyAppCredentials returns boolean false for a 401 rejection, but the
    // throw path may still surface one (e.g. a failing JWT mint); the mapping
    // stays consistent with the PAT branch.
    const result = await testGitHubConnection(
      { appAuthenticator: fakeAuthenticator, publicPrAnalysisEnabled: true },
      {
        probeApp: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 401", 401);
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "invalid_credential", testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("probes a configured PAT even when public PR analysis is disabled", async () => {
    const probeAnonymous = vi.fn();
    const probeApp = vi.fn();
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: false },
      { probeToken: vi.fn(async () => undefined), probeAnonymous, probeApp, now: fixedNow }
    );
    expect(result).toEqual({ status: "connected", mode: "pat", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(probeAnonymous).not.toHaveBeenCalled();
    expect(probeApp).not.toHaveBeenCalled();
  });

  it("probes anonymous access last and distinguishes availability from rate limiting", async () => {
    const available = await testGitHubConnection(
      { publicPrAnalysisEnabled: true },
      { probeAnonymous: vi.fn(async () => undefined), now: fixedNow }
    );
    expect(available).toEqual({
      status: "anonymous_available",
      mode: "anonymous",
      testedAt: "2026-08-24T00:00:00.000Z"
    });

    const rateLimited = await testGitHubConnection(
      { publicPrAnalysisEnabled: true },
      {
        probeAnonymous: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 403", 403, undefined, "60", "0");
        }),
        now: fixedNow
      }
    );
    expect(rateLimited).toEqual({ status: "rate_limited", retryAfterMs: 60_000, testedAt: "2026-08-24T00:00:00.000Z" });

    const providerDown = await testGitHubConnection(
      { publicPrAnalysisEnabled: true },
      {
        probeAnonymous: vi.fn(async () => {
          throw new Error("network unreachable");
        }),
        now: fixedNow
      }
    );
    expect(providerDown).toEqual({ status: "unavailable", testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("sanitizes unexpected crashes into unavailable and never echoes the credential", async () => {
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw { unexpected: "ghp_test_fake object failure" };
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "unavailable", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("ghp_test_fake");
    expect(() => githubConnectionTestResponseSchema.parse(result)).not.toThrow();
  });

  it("normalizes non-GitHubApiError probe failures through the shared classification kernel", () => {
    const normalized = toGitHubApiError(new Error("plain failure"));
    expect(normalized.status).toBeUndefined();
  });
});

describe("testGitHubConnection unsaved draft PAT probe", () => {
  it("probes only the draft token and short-circuits every ACTIVE candidate", async () => {
    const probeToken = vi.fn(async () => undefined);
    const probeApp = vi.fn(async () => true);
    const probeAnonymous = vi.fn(async () => undefined);
    const result = await testGitHubConnection(
      {
        draftPublicReadToken: "ghp_draft_fake",
        publicReadToken: "ghp_test_fake",
        appAuthenticator: fakeAuthenticator,
        publicPrAnalysisEnabled: true
      },
      { probeToken, probeApp, probeAnonymous, now: fixedNow }
    );
    expect(result).toEqual({ status: "connected", mode: "pat", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(probeToken).toHaveBeenCalledTimes(1);
    expect(probeToken).toHaveBeenCalledWith("ghp_draft_fake", undefined);
    expect(probeApp).not.toHaveBeenCalled();
    expect(probeAnonymous).not.toHaveBeenCalled();
    expect(githubConnectionTestResponseSchema.parse(result)).toEqual(result);
  });

  it("probes the draft even when analysis is disabled and no ACTIVE credential exists", async () => {
    // The not_configured early return must not swallow an explicitly
    // requested draft probe.
    const probeToken = vi.fn(async () => undefined);
    const probeAnonymous = vi.fn();
    const result = await testGitHubConnection(
      { draftPublicReadToken: "ghp_draft_fake", publicPrAnalysisEnabled: false },
      { probeToken, probeAnonymous, now: fixedNow }
    );
    expect(result).toEqual({ status: "connected", mode: "pat", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(probeToken).toHaveBeenCalledWith("ghp_draft_fake", undefined);
    expect(probeAnonymous).not.toHaveBeenCalled();
  });

  it("maps a 401 draft rejection to invalid_credential", async () => {
    const result = await testGitHubConnection(
      { draftPublicReadToken: "ghp_draft_fake", publicPrAnalysisEnabled: true },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 401", 401);
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "invalid_credential", testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("maps a rate-limited draft probe to rate_limited with bounded retry metadata", async () => {
    const result = await testGitHubConnection(
      { draftPublicReadToken: "ghp_draft_fake", publicPrAnalysisEnabled: false },
      {
        probeToken: vi.fn(async () => {
          throw new GitHubApiError("GitHub request failed with status 429", 429, undefined, "30");
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "rate_limited", retryAfterMs: 30_000, testedAt: "2026-08-24T00:00:00.000Z" });
  });

  it("falls back to the ACTIVE runtime credential when no draft is supplied", async () => {
    const probeToken = vi.fn(async () => undefined);
    const result = await testGitHubConnection(
      { publicReadToken: "ghp_test_fake", publicPrAnalysisEnabled: true },
      { probeToken, now: fixedNow }
    );
    expect(result).toEqual({ status: "connected", mode: "pat", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(probeToken).toHaveBeenCalledWith("ghp_test_fake", undefined);
  });

  it("sanitizes draft-probe crashes into unavailable and never echoes the draft", async () => {
    const result = await testGitHubConnection(
      { draftPublicReadToken: "ghp_draft_fake", publicPrAnalysisEnabled: false },
      {
        probeToken: vi.fn(async () => {
          throw { unexpected: "ghp_draft_fake object failure" };
        }),
        now: fixedNow
      }
    );
    expect(result).toEqual({ status: "unavailable", testedAt: "2026-08-24T00:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("ghp_draft_fake");
  });
});
