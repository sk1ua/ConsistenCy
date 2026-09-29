import { randomUUID } from "node:crypto";
import type { ReviewJobStore } from "../jobQueue";
import type { AuditDomainStore } from "../audit/store";

export type ManualTriggerInput = {
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  installationId: number;
  senderLogin: string;
};

/**
 * Manually trigger a review job.
 * @param jobs The job store to enqueue the review into.
 * @param input The manual trigger parameters.
 * @param repositoryStore Optional canonical identity lookup; when supplied and
 *   the remote full name matches a registered repository, the job persists that
 *   repository id. Unmatched remotes stay unassociated (no shadow records).
 * @returns The enqueued job ID.
 */
export function triggerManualReview(
  jobs: ReviewJobStore,
  input: ManualTriggerInput,
  repositoryStore?: Pick<AuditDomainStore, "findRepositoryByRemoteFullName">
): { jobId: string } {
  // Generate a fake delivery ID since it's a manual trigger
  const deliveryId = `manual_${randomUUID()}`;

  const canonicalRepository = repositoryStore?.findRepositoryByRemoteFullName(input.repository);

  const acceptance = jobs.acceptWebhookJob({
    delivery: {
      deliveryId,
      event: "manual",
      action: "trigger"
    },
    job: {
      kind: "pull_request",
      repository: input.repository,
      ...(canonicalRepository === undefined ? {} : { repositoryId: canonicalRepository.id }),
      pullRequestNumber: input.pullRequestNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
      installationId: input.installationId,
      senderLogin: input.senderLogin,
      action: "manual_trigger"
    }
  });

  if (acceptance.duplicate || !acceptance.job) {
    throw new Error("Failed to enqueue manual review job");
  }

  return { jobId: acceptance.job.id };
}
