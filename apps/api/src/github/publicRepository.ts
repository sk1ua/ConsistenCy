import {
  parseCanonicalGitHubRepositoryUrl,
  type Repository
} from "@consistency/schema";
import type { AuditDomainStore } from "../audit/store";
import {
  classifyGitHubApiError,
  GitHubApiError,
  GitHubProviderPayloadError,
  OctokitPullRequestClient,
  type RepositoryMetadata,
  type RepositoryMetadataClient
} from "./client";
import { normalizeGitHubFullName } from "./pullRequestReader";
import {
  resolveGitHubReadAccessCandidates,
  type GitHubInstallationAuthenticator
} from "./access";

export type PublicRepositoryErrorCode =
  | "PUBLIC_REPOSITORY_INVALID_INPUT"
  | "PUBLIC_REPOSITORY_UNSUPPORTED_HOST"
  | "PUBLIC_REPOSITORY_NOT_FOUND"
  | "PUBLIC_REPOSITORY_AUTH_REQUIRED"
  | "PUBLIC_REPOSITORY_RATE_LIMITED"
  | "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE";

export class PublicRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: PublicRepositoryErrorCode,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PublicRepositoryError";
  }
}

export type PublicRepositoryCoordinates = {
  readonly owner: string;
  readonly repo: string;
  readonly normalizedFullName: string;
};

function hasExplicitUrlPort(value: string): boolean {
  const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]+)/)?.[1];
  if (!authority) return false;
  return /:\d+$/.test(authority.slice(authority.lastIndexOf("@") + 1));
}

export function parsePublicRepositoryInput(value: string): PublicRepositoryCoordinates {
  if (value !== value.trim() || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new PublicRepositoryError(
      "GitHub repository input must not contain whitespace or control characters",
      "PUBLIC_REPOSITORY_INVALID_INPUT",
      400
    );
  }
  if (!value) {
    throw new PublicRepositoryError("Enter a GitHub repository", "PUBLIC_REPOSITORY_INVALID_INPUT", 400);
  }

  const trimmed = value;
  if (trimmed.includes("\\")) {
    throw new PublicRepositoryError("GitHub repository input must use canonical forward slashes", "PUBLIC_REPOSITORY_INVALID_INPUT", 400);
  }

  if (trimmed.includes("://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new PublicRepositoryError("Enter owner/repository or a canonical GitHub URL", "PUBLIC_REPOSITORY_INVALID_INPUT", 400);
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || hasExplicitUrlPort(trimmed)) {
      throw new PublicRepositoryError("Only https://github.com repository URLs are supported", "PUBLIC_REPOSITORY_UNSUPPORTED_HOST", 422);
    }
    const identity = parseCanonicalGitHubRepositoryUrl(trimmed);
    if (identity === null) {
      throw new PublicRepositoryError("Enter a canonical GitHub repository URL", "PUBLIC_REPOSITORY_INVALID_INPUT", 400);
    }
    return {
      owner: identity.owner,
      repo: identity.repo,
      normalizedFullName: identity.fullName.toLowerCase()
    };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.includes("@")) {
    throw new PublicRepositoryError("Only owner/repository or https://github.com URLs are supported", "PUBLIC_REPOSITORY_UNSUPPORTED_HOST", 422);
  }

  const identity = normalizeGitHubFullName(trimmed);
  if (identity === undefined) {
    throw new PublicRepositoryError("Enter a repository as owner/repository", "PUBLIC_REPOSITORY_INVALID_INPUT", 400);
  }
  return identity;
}

function safeRateLimitDetails(error: GitHubApiError): Record<string, unknown> | undefined {
  const details = {
    ...(error.rateLimitReset ? { rateLimitReset: error.rateLimitReset } : {}),
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {})
  };
  return Object.keys(details).length === 0 ? undefined : details;
}

function mapProviderError(error: unknown): PublicRepositoryError {
  if (error instanceof GitHubProviderPayloadError) {
    return new PublicRepositoryError(
      "GitHub returned invalid repository data",
      "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE",
      502
    );
  }
  if (!(error instanceof GitHubApiError)) {
    return new PublicRepositoryError(
      "GitHub repository data is temporarily unavailable",
      "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE",
      502
    );
  }
  switch (classifyGitHubApiError(error)) {
    case "rate_limited":
      return new PublicRepositoryError(
        "GitHub public API rate limit reached",
        "PUBLIC_REPOSITORY_RATE_LIMITED",
        429,
        safeRateLimitDetails(error)
      );
    case "not_found":
      return new PublicRepositoryError(
        "The public GitHub repository was not found or is unavailable",
        "PUBLIC_REPOSITORY_NOT_FOUND",
        404
      );
    case "access_denied":
      return new PublicRepositoryError(
        "This repository requires GitHub authentication or additional access",
        "PUBLIC_REPOSITORY_AUTH_REQUIRED",
        403
      );
    case "provider_unavailable":
      return new PublicRepositoryError(
        "GitHub repository data is temporarily unavailable",
        "PUBLIC_REPOSITORY_PROVIDER_UNAVAILABLE",
        502
      );
  }
}

export async function connectPublicGitHubRepository(options: {
  readonly input: string;
  readonly store: Pick<AuditDomainStore, "findRepositoryByRemoteFullName" | "connectGitHubRepository">;
  readonly authenticator?: GitHubInstallationAuthenticator;
  readonly publicReadToken?: string;
  readonly clientFactory?: (token?: string) => RepositoryMetadataClient;
}): Promise<Repository> {
  const coordinates = parsePublicRepositoryInput(options.input);
  const existing = options.store.findRepositoryByRemoteFullName(coordinates.normalizedFullName);

  const clientFactory = options.clientFactory ?? (token => new OctokitPullRequestClient(token));
  const candidates = await resolveGitHubReadAccessCandidates({
    owner: coordinates.owner,
    repo: coordinates.repo,
    authenticator: options.authenticator,
    publicReadToken: options.publicReadToken
  });
  let metadata: RepositoryMetadata | undefined;
  let finalError: unknown;
  for (const candidate of candidates) {
    try {
      metadata = await clientFactory(candidate.token).getRepository(coordinates);
      break;
    } catch (error) {
      if (error instanceof GitHubProviderPayloadError || !(error instanceof GitHubApiError)) {
        throw mapProviderError(error);
      }
      finalError = error;
    }
  }
  if (metadata === undefined) throw mapProviderError(finalError);
  if (metadata.private) {
    throw new PublicRepositoryError(
      "Private repositories require GitHub authentication and are not supported by public connection",
      "PUBLIC_REPOSITORY_AUTH_REQUIRED",
      403
    );
  }
  const canonical = normalizeGitHubFullName(metadata.fullName);
  if (canonical === undefined) throw mapProviderError(new GitHubProviderPayloadError());

  return options.store.connectGitHubRepository({
    displayName: metadata.name,
    source: "github",
    remoteFullName: `${canonical.owner}/${canonical.repo}`,
    defaultBranch: metadata.defaultBranch,
    monitoringEnabled: false
  }, existing === undefined ? undefined : { existingRepositoryId: existing.id });
}
