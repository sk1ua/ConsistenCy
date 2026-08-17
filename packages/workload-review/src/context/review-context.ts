/**
 * Review context construction — real PR-3 ContextManager COW.
 *
 * One BASE ContextImage per Review Run (policy/task/diff pinned, source and
 * evidence hot). Every specialized agent receives fork(base) with a private
 * overlay — never a duplicated PRReviewContext object.
 */

import {
  ContextManager,
  asContextPageId,
  type ContextImageId,
  type ContextPageId,
  type EvidenceSnapshot,
} from "@consistency/kernel";
import type { PRReviewContext } from "@consistency/schema";

export interface ReviewContextBuildInput {
  readonly jobId: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber?: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly context: PRReviewContext;
  /** Snapshot-backed content per changed path (path → content). */
  readonly snapshotContents: ReadonlyMap<string, string>;
  readonly evidence: readonly EvidenceSnapshot[];
  readonly publicationPolicy: string;
}

export interface ReviewContextBuildResult {
  readonly baseImage: ContextImageId;
  readonly sourcePages: ReadonlyMap<string, string>; // path → page id
}

function pageId(prefix: string, jobId: string, suffix: string): ContextPageId {
  return asContextPageId(`${prefix}_${jobId}_${suffix}`);
}

export function buildReviewBaseContext(
  manager: ContextManager,
  input: ReviewContextBuildInput,
): ReviewContextBuildResult {
  const image = manager.createImage();

  // Policy (pinned) — the grounding contract for this workload.
  const policyPage = manager.createPage({
    id: pageId("policy", input.jobId, "review"),
    kind: "policy",
    text: [
      "ConsistenCy review policy:",
      "- deterministic evidence first; LLM output is reasoning, not fact",
      "- confirmed findings require a real file, changed-hunk lines, and corroborating evidence",
      "- no finding without repository-relative path and 1-based line numbers",
      "- never emit a raw credential value",
    ].join("\n"),
    estimatedTokens: 120,
    provenance: { producer: "workload-review", producerVersion: "1.0.0" },
  });
  manager.attach(image, policyPage, "pinned");

  // Task (pinned).
  const changeSetLine =
    input.pullRequestNumber === undefined
      ? "Change set: local repository review"
      : `Pull request: #${input.pullRequestNumber}`;
  const taskPage = manager.createPage({
    id: pageId("task", input.jobId, "review"),
    kind: "task",
    text: [
      `Repository: ${input.repositoryFullName}`,
      changeSetLine,
      `Base/head: ${input.baseSha}..${input.headSha}`,
      `Changed files: ${input.context.changedFiles.map((f) => `${f.path} (${f.status})`).join(", ")}`,
      `Publication policy: ${input.publicationPolicy}`,
    ].join("\n"),
    estimatedTokens: 200,
    provenance: { repository: input.repositoryFullName, sha: input.headSha, producer: "workload-review", producerVersion: "1.0.0" },
  });
  manager.attach(image, taskPage, "pinned");

  // Diff (pinned).
  const diffPage = manager.createPage({
    id: pageId("diff", input.jobId, "review"),
    kind: "diff",
    text: input.context.diff.slice(0, 80_000),
    estimatedTokens: 2000,
    provenance: { repository: input.repositoryFullName, sha: input.headSha, producer: "context-builder", producerVersion: "1.0.0" },
  });
  manager.attach(image, diffPage, "pinned");

  // Source pages (hot) — snapshot-backed immutable content.
  const sourcePages = new Map<string, string>();
  let sourceIndex = 0;
  for (const changed of input.context.changedFiles) {
    const content = input.snapshotContents.get(changed.path);
    if (content === undefined) continue; // removed / unavailable at head
    sourceIndex += 1;
    const sourcePage = manager.createPage({
      id: pageId("source", input.jobId, String(sourceIndex)),
      kind: "source",
      text: content,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      source: { kind: "repository", repository: input.repositoryFullName, sha: input.headSha, path: changed.path },
      provenance: { repository: input.repositoryFullName, sha: input.headSha, producer: "workload-review", producerVersion: "1.0.0" },
    });
    manager.attach(image, sourcePage, "hot");
    sourcePages.set(changed.path, sourcePage);
  }

  // Evidence pages (hot).
  for (const record of input.evidence) {
    const evidencePage = manager.createPage({
      id: pageId("evidence", input.jobId, record.id),
      kind: "evidence",
      text: JSON.stringify({
        ruleId: record.ruleId ?? record.source,
        source: record.source,
        location: record.location,
        confidence: record.confidence,
        fingerprint: record.fingerprint,
      }),
      estimatedTokens: 64,
      provenance: {
        repository: record.provenance.repository,
        sha: record.provenance.sha,
        producer: record.provenance.analyzer,
        producerVersion: record.provenance.analyzerVersion,
      },
    });
    manager.attach(image, evidencePage, "hot");
  }

  return { baseImage: image, sourcePages };
}
