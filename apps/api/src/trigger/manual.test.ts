import { describe, expect, it } from "vitest";
import type { Repository } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { triggerManualReview } from "./manual";

const canonicalRepository: Repository = {
  id: "repo_manual_canonical",
  displayName: "ConsistenCy",
  source: "local_git",
  remoteFullName: "sk1ua/ConsistenCy",
  trustLevel: "trusted_local",
  monitoringEnabled: true,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z"
};

const input = {
  repository: "sk1ua/ConsistenCy",
  pullRequestNumber: 31,
  baseSha: "abcdef1",
  headSha: "1234567",
  installationId: 123,
  senderLogin: "octocat"
};

function repositoryStore(match?: Repository) {
  return {
    findRepositoryByRemoteFullName: (remoteFullName: string) =>
      match !== undefined && remoteFullName.toLowerCase() === match.remoteFullName?.toLowerCase()
        ? match
        : undefined
  };
}

describe("triggerManualReview canonical repository association", () => {
  it("associates a manually triggered job with the canonical repository record", () => {
    const jobs = new InMemoryJobQueue();
    const { jobId } = triggerManualReview(jobs, input, repositoryStore(canonicalRepository));

    expect(jobs.get(jobId)?.repositoryId).toBe(canonicalRepository.id);
    // Per-repository history reads strictly by repository_id; manual triggers
    // must surface on the repository detail page like every other intake.
    expect(jobs.listJobsForRepository(canonicalRepository.id).map(job => job.id)).toContain(jobId);
  });

  it("enqueues unassociated jobs without inventing a repositoryId", () => {
    const jobs = new InMemoryJobQueue();

    const unmatched = triggerManualReview(
      jobs,
      { ...input, repository: "other/repository" },
      repositoryStore(canonicalRepository)
    );
    expect(jobs.get(unmatched.jobId)?.repositoryId).toBeUndefined();

    // No store injected at all (legacy callers) must keep working.
    const withoutStore = triggerManualReview(jobs, input);
    expect(jobs.get(withoutStore.jobId)?.repositoryId).toBeUndefined();

    expect(jobs.list()).toHaveLength(2);
  });
});
