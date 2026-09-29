import { existsSync, readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { toGitHubApiError } from "./client";

export type InstallationToken = {
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type AppAuth = (options: {
  type: "installation" | "app";
  installationId?: number;
  refresh?: boolean;
}) => Promise<InstallationToken>;

export type AppAuthFactory = (options: {
  appId: string;
  privateKey: string;
}) => AppAuth;

export function normalizeGitHubPrivateKey(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  if (!unquoted.includes("-----BEGIN") && existsSync(unquoted)) {
    return readFileSync(unquoted, "utf8").replace(/\\n/g, "\n").trim();
  }
  return unquoted.replace(/\\n/g, "\n").trim();
}

export class GitHubAppAuthenticator {
  private readonly auth: AppAuth;

  constructor(
    options: { appId: string; privateKey: string },
    authFactory: AppAuthFactory = createAppAuth as unknown as AppAuthFactory
  ) {
    const privateKey = normalizeGitHubPrivateKey(options.privateKey);
    if (!privateKey.includes("-----BEGIN") || !privateKey.includes("PRIVATE KEY-----")) {
      throw new Error("GITHUB_PRIVATE_KEY must be a PEM encoded private key");
    }
    this.auth = authFactory({ appId: options.appId, privateKey });
  }

  async getInstallationToken(installationId: number, signal?: AbortSignal, forceRefresh = false): Promise<InstallationToken> {
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error("installationId must be a positive integer");
    }
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const tokenPromise = (async () => {
      const authentication = await this.auth({ type: "installation", installationId, refresh: forceRefresh });
      return {
        token: authentication.token,
        createdAt: authentication.createdAt,
        expiresAt: authentication.expiresAt
      };
    })();

    if (!signal) {
      return tokenPromise;
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });

      tokenPromise
        .then(res => {
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted) resolve(res);
        })
        .catch(err => {
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted) reject(err);
        });
    });
  }

  async getRepositoryInstallationId(owner: string, repo: string): Promise<number> {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("Repository coordinates are invalid");
    }
    const appAuthentication = await this.auth({ type: "app" });
    const octokit = new Octokit({ auth: appAuthentication.token });
    try {
      const response = await octokit.rest.apps.getRepoInstallation({ owner, repo });
      return response.data.id;
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
      if (status === 404) {
        throw new Error("GitHub App is not installed on this repository");
      }
      throw error;
    }
  }

  /**
   * Repository-independent credential validation for the Settings connection
   * probe: one authenticated read-only `GET /app` call with the app JWT.
   * Returns true when GitHub accepts the credentials, false on a 401
   * rejection, and throws a normalized GitHubApiError for every other
   * failure (rate limits, network errors, 5xx). Never returns a token.
   */
  async verifyAppCredentials(signal?: AbortSignal): Promise<boolean> {
    const appAuthentication = await this.auth({ type: "app" });
    const octokit = new Octokit({ auth: appAuthentication.token });
    try {
      await octokit.rest.apps.getAuthenticated(signal ? { request: { signal } } : {});
      return true;
    } catch (error) {
      const apiError = toGitHubApiError(error);
      if (apiError.status === 401) return false;
      throw apiError;
    }
  }
}
