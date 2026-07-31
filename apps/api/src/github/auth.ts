import { existsSync, readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";

export type InstallationToken = {
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type AppAuth = (options: {
  type: "installation";
  installationId: number;
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
}
