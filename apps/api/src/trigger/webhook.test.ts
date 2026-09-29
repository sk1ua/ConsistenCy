import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Repository } from "@consistency/schema";
import { InMemoryJobQueue } from "../jobQueue";
import { processGitHubWebhook, type WebhookHeaders } from "./webhook";

const WEBHOOK_SECRET = "webhook-secret";

const canonicalRepository: Repository = {
  id: "repo_webhook_canonical",
  displayName: "ConsistenCy",
  source: "local_git",
  remoteFullName: "sk1ua/ConsistenCy",
  trustLevel: "trusted_local",
  monitoringEnabled: true,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z"
};

function repositoryStore(match?: Repository) {
  return {
    findRepositoryByRemoteFullName: (remoteFullName: string) =>
      match !== undefined && remoteFullName.toLowerCase() === match.remoteFullName?.toLowerCase()
        ? match
        : undefined
  };
}

function pullRequestWebhook(fullName: string, deliveryId: string): { headers: WebhookHeaders; body: Buffer } {
  const payload = {
    action: "synchronize",
    repository: { full_name: fullName },
    installation: { id: 123 },
    sender: { login: "octocat" },
    pull_request: {
      number: 31,
      base: { sha: "abcdef1" },
      head: { sha: "1234567" }
    }
  };
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  return {
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature
    },
    body
  };
}

describe("processGitHubWebhook canonical repository association", () => {
  it("associates an enqueued pull request job with the canonical repository record", () => {
    const jobs = new InMemoryJobQueue();
    const result = processGitHubWebhook({
      ...pullRequestWebhook("SK1UA/ConsistenCy", "delivery-canonical"),
      secret: WEBHOOK_SECRET,
      jobs,
      repositoryStore: repositoryStore(canonicalRepository)
    });

    expect(result.status).toBe("enqueued");
    expect(result.job?.repositoryId).toBe(canonicalRepository.id);
    // Per-repository history reads strictly by repository_id; resolving the
    // canonical identity at intake must make the job discoverable there.
    expect(jobs.listJobsForRepository(canonicalRepository.id).map(job => job.id)).toContain(result.job?.id);
  });

  it("keeps unassociated jobs in the global queue without inventing a repositoryId", () => {
    const jobs = new InMemoryJobQueue();

    const unmatched = processGitHubWebhook({
      ...pullRequestWebhook("other/repository", "delivery-unmatched"),
      secret: WEBHOOK_SECRET,
      jobs,
      repositoryStore: repositoryStore(canonicalRepository)
    });
    expect(unmatched.status).toBe("enqueued");
    expect(unmatched.job?.repositoryId).toBeUndefined();
    // No shadow repository record may be created for unknown remotes.
    expect(jobs.list().some(job => job.repositoryId !== undefined)).toBe(false);

    const withoutStore = processGitHubWebhook({
      ...pullRequestWebhook("sk1ua/ConsistenCy", "delivery-no-store"),
      secret: WEBHOOK_SECRET,
      jobs
    });
    expect(withoutStore.status).toBe("enqueued");
    expect(withoutStore.job?.repositoryId).toBeUndefined();

    expect(jobs.list()).toHaveLength(2);
  });
});
