import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppAuthenticator, normalizeGitHubPrivateKey, type AppAuthFactory } from "./auth";

describe("GitHubAppAuthenticator", () => {
  it("normalizes escaped newlines in environment private keys", () => {
    expect(normalizeGitHubPrivateKey("-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"))
      .toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("loads private keys from a configured file path", () => {
    const directory = mkdtempSync(join(tmpdir(), "consistency-key-"));
    try {
      const keyPath = join(directory, "github-app.pem");
      writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", "utf8");

      expect(normalizeGitHubPrivateKey(keyPath))
        .toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requests an installation token for the requested installation", async () => {
    const auth = vi.fn(async () => ({
      token: "installation-token",
      createdAt: "2026-06-11T00:00:00.000Z",
      expiresAt: "2026-06-11T01:00:00.000Z"
    }));
    const factory = vi.fn(() => auth) as unknown as AppAuthFactory;
    const authenticator = new GitHubAppAuthenticator(
      {
        appId: "123",
        privateKey: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"
      },
      factory
    );

    await expect(authenticator.getInstallationToken(456)).resolves.toMatchObject({
      token: "installation-token"
    });
    expect(factory).toHaveBeenCalledWith({
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    });
    expect(auth).toHaveBeenCalledWith({ type: "installation", installationId: 456, refresh: false });

    await authenticator.getInstallationToken(456, undefined, true);
    expect(auth).toHaveBeenLastCalledWith({ type: "installation", installationId: 456, refresh: true });
  });

  it("rejects malformed keys and installation ids before making a request", async () => {
    expect(() => new GitHubAppAuthenticator({ appId: "123", privateKey: "not-a-key" })).toThrow(/PEM/);

    const factory = (() => vi.fn()) as unknown as AppAuthFactory;
    const authenticator = new GitHubAppAuthenticator(
      { appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
      factory
    );
    await expect(authenticator.getInstallationToken(0)).rejects.toThrow(/positive integer/);
  });
});
