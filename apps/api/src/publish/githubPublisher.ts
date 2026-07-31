import { Octokit } from "@octokit/rest";
import type { ReviewReport } from "@consistency/schema";
import { splitRepositoryFullName } from "../github/client";
import { renderReviewComment } from "../review/report/markdownRenderer";
import { sanitizePublicError } from "../security/redact";
import { PermanentPublishError, TransientPublishError, RateLimitedPublishError, PublishError } from "./error";

export type PublishToGitHubOptions = {
  report: ReviewReport;
  repositoryFullName: string;
  pullRequestNumber: number;
  token: string;
  externalId?: string | null;
  providerName?: string;
  webBaseUrl?: string;
  signal?: AbortSignal;
};

export function buildGitHubCommentMarker(jobId: string): string {
  return `<!-- consistency-job:${jobId}:github_comment -->`;
}

export function classifyGitHubError(error: unknown): PublishError {
  if (error instanceof PublishError) return error;

  const err = error as any;
  const status = typeof err?.status === "number" ? err.status : undefined;
  const rawMessage = typeof err?.message === "string" ? err.message : String(error);

  const sanitizedMessage = sanitizePublicError(rawMessage).slice(0, 500);

  // Signal / DOMException cancellation
  if (err?.name === "AbortError" || err?.name === "DOMException") {
    return new TransientPublishError("Operation aborted", status);
  }

  // Network level failures
  const code = err?.code ?? err?.cause?.code;
  if (code === "EPIPE" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || err?.name === "FetchError") {
    return new TransientPublishError(sanitizedMessage, status);
  }

  // Parse HTTP headers for Rate Limits
  const headers = err?.response?.headers ?? {};
  const remaining = headers["x-ratelimit-remaining"];
  const resetHeader = headers["x-ratelimit-reset"] ?? headers["retry-after"];

  let retryAt: Date | undefined;
  if (resetHeader) {
    const parsedNum = Number(resetHeader);
    if (!Number.isNaN(parsedNum)) {
      // If resetHeader is unix timestamp in seconds
      retryAt = parsedNum > 1e9 ? new Date(parsedNum * 1000) : new Date(Date.now() + parsedNum * 1000);
    }
  }

  if (status === 429 || (status === 403 && remaining === "0")) {
    return new RateLimitedPublishError(sanitizedMessage, status, retryAt);
  }

  if (status === 408 || (status && status >= 500 && status <= 599)) {
    return new TransientPublishError(sanitizedMessage, status, retryAt);
  }

  if (status === 401 || status === 403 || status === 404 || status === 422) {
    return new PermanentPublishError(sanitizedMessage, status);
  }

  // Fallback for unknown HTTP 4xx or unexpected failures
  if (status && status >= 400 && status < 500) {
    return new PermanentPublishError(sanitizedMessage, status);
  }

  return new TransientPublishError(sanitizedMessage, status);
}

export type GitHubCommentClient = {
  paginate: (...args: any[]) => Promise<Array<{ id: number; body?: string | null }>>;
  updateComment: (input: any) => Promise<{ data: { id: number } }>;
  createComment: (input: any) => Promise<{ data: { id: number } }>;
};

export async function publishToGitHub(
  options: PublishToGitHubOptions,
  deps: { createClient?: (token: string) => GitHubCommentClient } = {}
): Promise<{ commentId: string }> {
  if (options.signal?.aborted) {
    throw new TransientPublishError("Operation aborted before GitHub request", 499);
  }

  const { owner, repo } = splitRepositoryFullName(options.repositoryFullName);
  const octokit = deps.createClient?.(options.token) ?? (new Octokit({ auth: options.token }) as any);
  const marker = buildGitHubCommentMarker(options.report.jobId);
  const renderedContent = renderReviewComment(options.report, {
    providerName: options.providerName ?? "unknown",
    webBaseUrl: options.webBaseUrl
  });
  const body = `${renderedContent}\n\n${marker}`;

  try {
    // Step 1: Fast-path via externalId if present
    if (options.externalId) {
      try {
        const updateRes = await (octokit.rest?.issues?.updateComment ?? octokit.updateComment)({
          owner,
          repo,
          comment_id: Number(options.externalId),
          body,
          request: { signal: options.signal }
        });
        const id = updateRes?.data?.id ?? updateRes?.id;
        return { commentId: String(id) };
      } catch (err: any) {
        if (err?.status !== 404) {
          throw err;
        }
        // Fall through to paginated marker search if 404
      }
    }

    // Step 2: Paginated marker search across ALL issue comments
    const paginateFn = octokit.paginate ?? octokit.rest?.paginate;
    const listCommentsFn = octokit.rest?.issues?.listComments ?? octokit.listComments;

    const allComments = await (paginateFn ? paginateFn(listCommentsFn, {
      owner,
      repo,
      issue_number: options.pullRequestNumber,
      per_page: 100,
      request: { signal: options.signal }
    }) : listCommentsFn({
      owner,
      repo,
      issue_number: options.pullRequestNumber,
      per_page: 100,
      request: { signal: options.signal }
    }));

    const existingComment = (allComments as Array<{ id: number; body?: string | null }>).find(comment => comment.body?.includes(marker));

    if (existingComment) {
      const updateFn = octokit.rest?.issues?.updateComment ?? octokit.updateComment;
      const updateRes = await updateFn({
        owner,
        repo,
        comment_id: existingComment.id,
        body,
        request: { signal: options.signal }
      });
      const id = updateRes?.data?.id ?? updateRes?.id;
      return { commentId: String(id) };
    }

    // Step 3: Create new comment if no existing comment matched
    const createFn = octokit.rest?.issues?.createComment ?? octokit.createComment;
    const createRes = await createFn({
      owner,
      repo,
      issue_number: options.pullRequestNumber,
      body,
      request: { signal: options.signal }
    });

    const id = createRes?.data?.id ?? createRes?.id;
    return { commentId: String(id) };
  } catch (error) {
    throw classifyGitHubError(error);
  }
}
