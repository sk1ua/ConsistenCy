import { createAppAuth } from "@octokit/auth-app";

export type InstallationToken = {
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type AppAuth = (options: {
  type: "installation";
  installationId: number;
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

  async getInstallationToken(installationId: number): Promise<InstallationToken> {
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error("installationId must be a positive integer");
    }
    const authentication = await this.auth({ type: "installation", installationId });
    return {
      token: authentication.token,
      createdAt: authentication.createdAt,
      expiresAt: authentication.expiresAt
    };
  }
}
