import { describe, expect, it, vi } from "vitest";
import type { Repository } from "@consistency/schema";
import { GitHubApiError, GitHubProviderPayloadError } from "./client";
import { connectPublicGitHubRepository, parsePublicRepositoryInput } from "./publicRepository";

const existingRepository: Repository = {
  id: "repo_existing",
  displayName: "Repository",
  source: "local_git",
  remoteFullName: "Acme/Repository",
  defaultBranch: "main",
  trustLevel: "untrusted_readonly",
  monitoringEnabled: true,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
};

function store(existing?: Repository) {
  return {
    findRepositoryByRemoteFullName: vi.fn(() => existing),
    connectGitHubRepository: vi.fn((
      input: { displayName: string; remoteFullName?: string; defaultBranch?: string },
      options?: { existingRepositoryId?: string }
    ) => ({
      ...existingRepository,
      id: options?.existingRepositoryId ?? "repo_created",
      source: options?.existingRepositoryId === undefined ? "github" as const : existing?.source ?? "github" as const,
      displayName: input.displayName,
      remoteFullName: input.remoteFullName,
      defaultBranch: input.defaultBranch,
      monitoringEnabled: options?.existingRepositoryId === undefined ? false : existing?.monitoringEnabled ?? false
    }))
  };
}

describe("public GitHub repository connection", () => {
  it.each([
    ["Acme/Repository", "acme/repository"],
    ["acme-org/repo.name_with-parts", "acme-org/repo.name_with-parts"],
    ["https://github.com/Acme/Repository", "acme/repository"]
  ])("accepts %s", (input, normalized) => {
    expect(parsePublicRepositoryInput(input).normalizedFullName).toBe(normalized);
  });

  it.each([
    ["", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://gitlab.com/owner/repo", "PUBLIC_REPOSITORY_UNSUPPORTED_HOST"],
    ["ssh://git@github.com/owner/repo", "PUBLIC_REPOSITORY_UNSUPPORTED_HOST"],
    ["https://github.com/owner/repo/", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://GITHUB.COM/owner/repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/owner/repo/extra", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/owner/repo?tab=readme", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com:443/owner/repo", "PUBLIC_REPOSITORY_UNSUPPORTED_HOST"],
    ["-bad/repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["bad-/repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["./repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["../repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner/.", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner/..", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner/...", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    [" owner/repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner/repo ", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner\t/repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner/repo\n", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["owner/rep\u0000o", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/owner/%2e%2e/repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/owner/./repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/owner/segment/../repo", "PUBLIC_REPOSITORY_INVALID_INPUT"],
    [String.raw`https://github.com/owner\repo`, "PUBLIC_REPOSITORY_INVALID_INPUT"],
    [String.raw`https://github.com/owner/repo\extra`, "PUBLIC_REPOSITORY_INVALID_INPUT"],
    ["https://github.com/owner/repo\t", "PUBLIC_REPOSITORY_INVALID_INPUT"]
  ])("rejects %s without a provider read", async (input, code) => {
    const repositoryStore = store();
    const clientFactory = vi.fn();
    await expect(connectPublicGitHubRepository({ input, store: repositoryStore, clientFactory }))
      .rejects.toMatchObject({ code });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("verifies an existing canonical local repository before returning its opaque ID", async () => {
    const repositoryStore = store(existingRepository);
    const clientFactory = vi.fn(() => ({
      getRepository: async () => ({
        fullName: "Acme/Repository",
        name: "Provider Repository",
        defaultBranch: "trunk",
        private: false
      })
    }));
    await expect(connectPublicGitHubRepository({
      input: "acme/repository",
      store: repositoryStore,
      clientFactory
    })).resolves.toMatchObject({
      id: existingRepository.id,
      source: "local_git",
      displayName: "Provider Repository",
      defaultBranch: "trunk"
    });
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(repositoryStore.connectGitHubRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Provider Repository",
        remoteFullName: "Acme/Repository",
        defaultBranch: "trunk"
      }),
      { existingRepositoryId: existingRepository.id }
    );
  });

  it.each([
    [new GitHubApiError("deleted", 404), "PUBLIC_REPOSITORY_NOT_FOUND"],
    [null, "PUBLIC_REPOSITORY_AUTH_REQUIRED"]
  ] as const)("does not trust an existing unverified row when provider access fails", async (failure, code) => {
    const repositoryStore = store({ ...existingRepository, source: "github" });
    await expect(connectPublicGitHubRepository({
      input: "acme/repository",
      store: repositoryStore,
      clientFactory: () => ({
        getRepository: async () => {
          if (failure !== null) throw failure;
          return {
            fullName: "Acme/Repository",
            name: "Repository",
            defaultBranch: "main",
            private: true
          };
        }
      })
    })).rejects.toMatchObject({ code });
    expect(repositoryStore.connectGitHubRepository).not.toHaveBeenCalled();
  });

  it.each([
    " Acme/Repository",
    "Acme/Repository ",
    "Acme/Repo\t",
    "Acme/Repo\n",
    "Acme/Rep\u0000o"
  ])("rejects provider metadata with a non-strict full name %s", async fullName => {
    const repositoryStore = store();
    await expect(connectPublicGitHubRepository({
      input: "acme/repository",
      store: repositoryStore,
      clientFactory: () => ({
        getRepository: async () => ({
          fullName,
          name: "Repository",
          defaultBranch: "main",
          private: false
        })
      })
    })).rejects.toMatchObject({ code: "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE" });
    expect(repositoryStore.connectGitHubRepository).not.toHaveBeenCalled();
  });

  it("verifies a public repository and persists provider-canonical metadata", async () => {
    const repositoryStore = store();
    const repository = await connectPublicGitHubRepository({
      input: "acme/repository",
      store: repositoryStore,
      clientFactory: () => ({
        getRepository: async () => ({
          fullName: "Acme/Renamed",
          name: "Renamed",
          defaultBranch: "trunk",
          private: false
        })
      })
    });
    expect(repository).toMatchObject({
      id: "repo_created",
      source: "github",
      remoteFullName: "Acme/Renamed",
      defaultBranch: "trunk"
    });
  });

  it("uses GitHub App installation access before PAT and anonymous", async () => {
    const seenTokens: Array<string | undefined> = [];
    await connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      authenticator: {
        getRepositoryInstallationId: async () => 42,
        getInstallationToken: async installationId => ({ token: `app-${installationId}` })
      },
      publicReadToken: "public-read",
      clientFactory: token => ({
        getRepository: async () => {
          seenTokens.push(token);
          return { fullName: "acme/repository", name: "repository", defaultBranch: "main", private: false };
        }
      })
    });
    expect(seenTokens).toEqual(["app-42"]);
  });

  it("falls back from GitHub App failure to PAT", async () => {
    const seenTokens: Array<string | undefined> = [];
    await connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      authenticator: {
        getRepositoryInstallationId: async () => 7,
        getInstallationToken: async () => ({ token: "app-read" })
      },
      publicReadToken: "public-read",
      clientFactory: token => ({
        getRepository: async () => {
          seenTokens.push(token);
          if (token === "app-read") throw new GitHubApiError("App access unavailable", 403);
          return { fullName: "acme/repository", name: "repository", defaultBranch: "main", private: false };
        }
      })
    });
    expect(seenTokens).toEqual(["app-read", "public-read"]);
  });

  it("fails closed on malformed metadata without trying another credential", async () => {
    const seenTokens: Array<string | undefined> = [];
    await expect(connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      authenticator: {
        getRepositoryInstallationId: async () => 7,
        getInstallationToken: async () => ({ token: "app-read" })
      },
      publicReadToken: "public-read",
      clientFactory: token => ({
        getRepository: async () => {
          seenTokens.push(token);
          throw new GitHubProviderPayloadError();
        }
      })
    })).rejects.toMatchObject({ code: "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE" });
    expect(seenTokens).toEqual(["app-read"]);
  });

  it("fails closed on an untyped provider failure without trying another credential", async () => {
    const seenTokens: Array<string | undefined> = [];
    await expect(connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      publicReadToken: "public-read",
      clientFactory: token => ({
        getRepository: async () => {
          seenTokens.push(token);
          throw new Error("unexpected provider payload failure");
        }
      })
    })).rejects.toMatchObject({ code: "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE" });
    expect(seenTokens).toEqual(["public-read"]);
  });

  it("falls back from PAT provider failure to anonymous", async () => {
    const seenTokens: Array<string | undefined> = [];
    await connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      publicReadToken: "public-read",
      clientFactory: token => ({
        getRepository: async () => {
          seenTokens.push(token);
          if (token !== undefined) throw new GitHubApiError("PAT unavailable", 401);
          return { fullName: "acme/repository", name: "repository", defaultBranch: "main", private: false };
        }
      })
    });
    expect(seenTokens).toEqual(["public-read", undefined]);
  });

  it("supports anonymous-only public verification", async () => {
    const seenTokens: Array<string | undefined> = [];
    await connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      clientFactory: token => ({
        getRepository: async () => {
          seenTokens.push(token);
          return { fullName: "acme/repository", name: "repository", defaultBranch: "main", private: false };
        }
      })
    });
    expect(seenTokens).toEqual([undefined]);
  });

  it("preserves anonymous fallback and maps private, missing, rate-limit, and provider failures", async () => {
    const cases = [
      [new GitHubApiError("hidden", 404), "PUBLIC_REPOSITORY_NOT_FOUND"],
      [new GitHubApiError("hidden", 403), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 429), "PUBLIC_REPOSITORY_RATE_LIMITED"],
      [new GitHubApiError("hidden", 403, undefined, undefined, "0"), "PUBLIC_REPOSITORY_RATE_LIMITED"],
      [new GitHubApiError("hidden", 403, undefined, "30", "50"), "PUBLIC_REPOSITORY_RATE_LIMITED"],
      [new GitHubApiError("hidden", 403, undefined, "Sun, 06 Nov 1994 08:49:37 GMT", "50"), "PUBLIC_REPOSITORY_RATE_LIMITED"],
      [new GitHubApiError("hidden", 403, undefined, "12/31/2026", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "2026-12-31T00:00:00Z", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "Sunday, 06-Nov-94 08:49:37 GMT", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "Sun Nov  6 08:49:37 1994", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "not-a-retry-value", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "-1", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "1.5", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "Mon, 06 Nov 1994 08:49:37 GMT", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 403, undefined, "Sun, 31 Feb 1994 08:49:37 GMT", "50"), "PUBLIC_REPOSITORY_AUTH_REQUIRED"],
      [new GitHubApiError("hidden", 503), "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE"]
    ] as const;
    for (const [providerError, code] of cases) {
      const seenTokens: Array<string | undefined> = [];
      await expect(connectPublicGitHubRepository({
        input: "acme/repository",
        store: store(),
        publicReadToken: "configured-read-token",
        clientFactory: token => ({
          getRepository: async () => {
            seenTokens.push(token);
            throw providerError;
          }
        })
      })).rejects.toMatchObject({ code });
      expect(seenTokens).toEqual(["configured-read-token", undefined]);
    }

    await expect(connectPublicGitHubRepository({
      input: "acme/repository",
      store: store(),
      clientFactory: () => ({
        getRepository: async () => ({
          fullName: "acme/repository",
          name: "repository",
          defaultBranch: "main",
          private: true
        })
      })
    })).rejects.toMatchObject({ code: "PUBLIC_REPOSITORY_AUTH_REQUIRED" });
  });
});
