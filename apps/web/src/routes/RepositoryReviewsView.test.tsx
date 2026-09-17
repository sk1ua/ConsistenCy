/**
 * RepositoryReviewsView — canonical association and empty/error honesty.
 *
 *   R1  only jobs with matching repositoryId appear (no name inference)
 *   R2  empty list is distinct from load failure
 *   R3  empty state offers a path back to overview to start a review
 */
// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReviewJob } from "@consistency/schema";

let reviewsFixture: ReviewJob[] = [];
let reviewsError: Error | null = null;

vi.mock("../api/client", () => ({
  api: {
    repositoryReviews: vi.fn(async () => {
      if (reviewsError) throw reviewsError;
      return reviewsFixture;
    })
  }
}));

import {
  RepositoryReviewsView,
  canonicalRepositoryReviews
} from "./RepositoryReviewsView";

function job(partial: Partial<ReviewJob> & Pick<ReviewJob, "id" | "repositoryId">): ReviewJob {
  return {
    type: "review",
    status: "succeeded",
    repositoryFullName: "octo/demo",
    accessMode: "local_git",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    publicationPolicy: "disabled",
    createdAt: "2026-09-17T00:00:00.000Z",
    ...partial
  };
}

async function renderView(zh: boolean): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RepositoryReviewsView repositoryId="repo-1" zh={zh} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
  return { root, container };
}

afterEach(async () => {
  reviewsFixture = [];
  reviewsError = null;
  document.body.innerHTML = "";
});

describe("canonicalRepositoryReviews", () => {
  it("keeps only jobs whose opaque repositoryId matches", () => {
    const keep = job({ id: "keep", repositoryId: "repo-1" });
    const other = job({ id: "drop-other", repositoryId: "repo-2" });
    const legacy = job({ id: "legacy", repositoryId: "repo-1" });
    delete (legacy as { repositoryId?: string }).repositoryId;
    expect(canonicalRepositoryReviews([keep, other, legacy], "repo-1").map(row => row.id)).toEqual(["keep"]);
  });
});

describe("RepositoryReviewsView", () => {
  it("renders only canonically associated reviews", async () => {
    reviewsFixture = [
      job({ id: "job_keep_me_please", repositoryId: "repo-1", status: "succeeded" }),
      job({ id: "job_other_repo_here", repositoryId: "repo-2", status: "failed" })
    ];
    const { root, container } = await renderView(false);
    expect(container.textContent).toContain("job_keep_me_please".slice(0, 18));
    expect(container.textContent).not.toContain("job_other_repo_here".slice(0, 18));
    expect(container.textContent).toContain("1 total");
    root.unmount();
  });

  it("shows an empty state with overview CTA, not an error", async () => {
    reviewsFixture = [];
    const { root, container } = await renderView(true);
    expect(container.textContent).toContain("尚未审查过");
    const link = container.querySelector('a[href="/repositories/repo-1/overview"]');
    expect(link).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    root.unmount();
  });

  it("surfaces load failure distinctly from empty", async () => {
    reviewsError = new Error("boom");
    const { root, container } = await renderView(false);
    expect(container.textContent).toContain("Review history unavailable");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No reviews yet");
    root.unmount();
  });
});
