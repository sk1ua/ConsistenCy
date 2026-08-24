import { randomUUID } from "node:crypto";
import {
  agentRunSchema,
  publishOutboxItemSchema,
  reviewReportSchema,
  type AgentRun,
  type PublishOutboxItem,
  type PublishOutboxStatus,
  type ReviewReport
} from "@consistency/schema";
import type { ConsistencyDatabase } from "../db/connection";
import {
  normalizePullRequestNumberQuery,
  type CreateReviewJobInput,
  type GitHubCommentStatus,
  type JobStatus,
  type ReviewJob,
  type ReviewJobStore,
  type WebhookAcceptance,
  type WebhookDelivery,
  type WebhookJobInput
} from "../jobQueue";

class FencingRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencingRollbackError";
  }
}

export class SQLiteJobStore implements ReviewJobStore {
  constructor(private readonly database: ConsistencyDatabase) {}

  enqueue(input: CreateReviewJobInput): ReviewJob {
    const id = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    const accessMode = input.accessMode ?? "github_app";
    const publicationPolicy = accessMode === "public_read" || accessMode === "local_git"
      ? "disabled"
      : input.publicationPolicy ?? "github_comment";
    this.database.prepare(`
      INSERT INTO jobs (
        id, type, status, repository_full_name, repository_id, pull_request_number, repo_path,
        installation_id, access_mode, base_sha, head_sha, delivery_id, sender_login,
        action, publication_policy, llm_provider, llm_model, created_at, updated_at
      ) VALUES (?, 'PR_REVIEW', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.repository,
      input.repositoryId ?? null,
      input.pullRequestNumber ?? null,
      accessMode === "local_git" ? input.repoPath ?? null : null,
      accessMode === "github_app" ? input.installationId ?? null : null,
      accessMode,
      input.baseSha,
      input.headSha,
      input.deliveryId ?? null,
      input.senderLogin ?? null,
      input.action ?? null,
      publicationPolicy,
      input.llmProvider ?? null,
      input.llmModel ?? null,
      now,
      now
    );

    return this.get(id)!;
  }

  list(): ReviewJob[] {
    const rows = this.database.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as any[];
    return rows.map(row => this.rowToJob(row));
  }

  /**
   * Per-repository review history: ONLY jobs whose canonical opaque
   * repository_id matches (CKPT3 Phase 4 / D1). Legacy rows with no
   * association never appear here — no name-inference joins.
   */
  listJobsForRepository(repositoryId: string, limit = 50): ReviewJob[] {
    const normalized = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50;
    const rows = this.database
      .prepare("SELECT * FROM jobs WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(repositoryId, normalized) as any[];
    return rows.map(row => this.rowToJob(row));
  }

  listLatestPullRequestJobsForRepository(repositoryId: string, pullRequestNumbers: readonly number[]): ReviewJob[] {
    const requested = normalizePullRequestNumberQuery(pullRequestNumbers);
    if (requested.length === 0) return [];
    const placeholders = requested.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT j.*, r.report_json,
          ROW_NUMBER() OVER (
            PARTITION BY j.pull_request_number
            ORDER BY j.created_at DESC, j.updated_at DESC, j.id DESC
          ) AS latest_rank
        FROM jobs j
        LEFT JOIN reports r ON r.job_id = j.id
        WHERE j.repository_id = ?
          AND j.type = 'PR_REVIEW'
          AND j.pull_request_number IN (${placeholders})
      )
      SELECT * FROM ranked
      WHERE latest_rank = 1
      ORDER BY created_at DESC, updated_at DESC, id DESC
    `).all(repositoryId, ...requested) as any[];
    return rows.map(row => this.rowToJob(row));
  }

  get(id: string): ReviewJob | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return this.rowToJob(row);
  }

  nextQueued(): ReviewJob | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get() as any;
    if (!row) return undefined;
    return this.rowToJob(row);
  }

  claimNextQueued(): ReviewJob | undefined {
    return this.database.transaction(() => {
      const next = this.nextQueued();
      if (!next) return undefined;
      return this.markRunning(next.id);
    })();
  }

  markRunning(id: string): ReviewJob | undefined {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'
    `).run(now, now, id);

    if (result.changes === 0) return undefined;
    return this.get(id);
  }

  markSucceeded(id: string, result: ReviewReport): ReviewJob | undefined {
    const validatedReport = reviewReportSchema.parse(result);
    const now = new Date().toISOString();

    return this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO reports (id, job_id, report_json, created_at, github_comment_status)
        VALUES (?, ?, ?, ?, 'pending')
        ON CONFLICT(job_id) DO UPDATE SET report_json = excluded.report_json, created_at = excluded.created_at
      `).run(`report_${randomUUID()}`, id, JSON.stringify(validatedReport), validatedReport.createdAt);

      this.database.prepare(`
        UPDATE jobs SET status = 'succeeded', finished_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, id);

      return this.get(id);
    })();
  }

  markFailed(id: string, error: string): ReviewJob | undefined {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?
    `).run(error, now, now, id);
    return this.get(id);
  }

  persistReportAndEnqueuePublish(id: string, result: ReviewReport): ReviewJob | undefined {
    return this.database.transaction(() => {
      const job = this.get(id);
      if (!job) {
        throw new Error(`Job not found for persistReportAndEnqueuePublish: ${id}`);
      }

      if (job.status === "publishing" || job.status === "succeeded" || job.status === "publish_failed") {
        // Complete no-op: return existing job without report validation, backwards status regression or outbox modifications
        return job;
      }

      if (job.status !== "running" && job.status !== "awaiting_publish") {
        throw new Error(`Invalid job status '${job.status}' for persistReportAndEnqueuePublish`);
      }

      // Validate report schema AFTER passing job status checks
      const report = reviewReportSchema.parse(result);
      const now = new Date().toISOString();

      // Step 1: Upsert report
      this.database.prepare(`
        INSERT INTO reports (id, job_id, report_json, created_at, github_comment_status)
        VALUES (?, ?, ?, ?, 'pending')
        ON CONFLICT(job_id) DO UPDATE SET report_json = excluded.report_json, created_at = excluded.created_at
      `).run(`report_${randomUUID()}`, id, JSON.stringify(report), report.createdAt);

      if (job.publicationPolicy === "disabled") {
        this.database.prepare(`
          UPDATE reports SET github_comment_status = 'skipped', github_comment_error = NULL WHERE job_id = ?
        `).run(id);
        this.database.prepare(`
          UPDATE jobs SET status = 'succeeded', finished_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, id);
        return this.get(id);
      }

      // Step 2: Insert outbox row ON CONFLICT DO NOTHING
      this.database.prepare(`
        INSERT INTO publish_outbox (
          id, job_id, target, status, attempt_count, lease_generation, created_at, updated_at
        ) VALUES (?, ?, 'github_comment', 'pending', 0, 0, ?, ?)
        ON CONFLICT(job_id, target) DO NOTHING
      `).run(`outbox_${randomUUID()}`, id, now, now);

      // Step 3: Update job status to awaiting_publish if currently running
      if (job.status === "running") {
        this.database.prepare(`
          UPDATE jobs SET status = 'awaiting_publish', updated_at = ? WHERE id = ?
        `).run(now, id);
      }

      return this.get(id);
    })();
  }

  getPublishOutbox(jobId: string): PublishOutboxItem[] {
    const rows = this.database.prepare(`
      SELECT id, job_id, target, status, attempt_count, next_attempt_at, lease_owner, lease_expires_at, lease_generation, last_error, external_id, created_at, updated_at
      FROM publish_outbox
      WHERE job_id = ?
      ORDER BY id ASC
    `).all(jobId) as Array<{
      id: string | number;
      job_id: string;
      target: string;
      status: PublishOutboxStatus;
      attempt_count: number;
      next_attempt_at: string | null;
      lease_owner: string | null;
      lease_expires_at: string | null;
      lease_generation: number | null;
      last_error: string | null;
      external_id: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => publishOutboxItemSchema.parse({
      id: String(row.id),
      jobId: row.job_id,
      target: row.target,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      leaseGeneration: row.lease_generation ?? 0,
      lastError: row.last_error,
      externalId: row.external_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  claimPublishOutboxItem(owner: string, leaseDurationMs: number, limit = 1): PublishOutboxItem[] {
    if (limit <= 0) return [];
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAtIso = new Date(now.getTime() + leaseDurationMs).toISOString();

    return this.database.transaction(() => {
      const claimedRows = this.database.prepare(`
        UPDATE publish_outbox
        SET status = 'leased',
            lease_owner = ?,
            lease_expires_at = ?,
            lease_generation = lease_generation + 1,
            updated_at = ?
        WHERE id IN (
          SELECT o.id
          FROM publish_outbox o
          JOIN jobs j ON j.id = o.job_id
          WHERE (
            (
              o.status IN ('pending', 'retrying')
              AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
              AND j.status = 'awaiting_publish'
            )
            OR (
              o.status = 'leased'
              AND o.lease_expires_at IS NOT NULL
              AND o.lease_expires_at <= ?
              AND j.status = 'publishing'
            )
          )
          ORDER BY COALESCE(o.next_attempt_at, o.created_at) ASC, o.id ASC
          LIMIT ?
        )
        RETURNING id, job_id, target, status, attempt_count, next_attempt_at, lease_owner, lease_expires_at, lease_generation, last_error, external_id, created_at, updated_at
      `).all(owner, leaseExpiresAtIso, nowIso, nowIso, nowIso, limit) as any[];

      if (claimedRows.length === 0) return [];

      const distinctJobIds = Array.from(new Set(claimedRows.map((r: any) => r.job_id)));

      this.database.prepare(`
        UPDATE jobs
        SET status = 'publishing', updated_at = ?
        WHERE id IN (${distinctJobIds.map(() => "?").join(",")}) AND status = 'awaiting_publish'
      `).run(nowIso, ...distinctJobIds);

      const jobStatuses = this.database.prepare(`
        SELECT id, status FROM jobs WHERE id IN (${distinctJobIds.map(() => "?").join(",")})
      `).all(...distinctJobIds) as Array<{ id: string; status: string }>;

      if (jobStatuses.length !== distinctJobIds.length || jobStatuses.some(j => j.status !== "publishing")) {
        throw new FencingRollbackError("Job status verification failed during claim");
      }

      return claimedRows.map((row: any) => publishOutboxItemSchema.parse({
        id: String(row.id),
        jobId: row.job_id,
        target: row.target,
        status: row.status,
        attemptCount: row.attempt_count,
        nextAttemptAt: row.next_attempt_at,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        leaseGeneration: row.lease_generation ?? 0,
        lastError: row.last_error,
        externalId: row.external_id ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    })();
  }

  markPublishOutboxSuccess(
    id: string,
    owner: string,
    leaseGeneration: number,
    status: "published" | "skipped",
    externalId?: string
  ): boolean {
    const nowIso = new Date().toISOString();

    try {
      return this.database.transaction(() => {
        const outboxRes = this.database.prepare(`
          UPDATE publish_outbox
          SET status = ?, external_id = COALESCE(?, external_id), lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
        `).run(status, externalId ?? null, nowIso, id, owner, leaseGeneration);

        if (outboxRes.changes !== 1) {
          throw new FencingRollbackError("Outbox lease generation fencing token mismatch");
        }

        const outboxItem = this.database.prepare("SELECT job_id FROM publish_outbox WHERE id = ?").get(id) as { job_id: string } | undefined;
        if (!outboxItem) {
          throw new FencingRollbackError("Outbox item not found");
        }

        const jobRes = this.database.prepare(`
          UPDATE jobs SET status = 'succeeded', finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'publishing'
        `).run(nowIso, nowIso, outboxItem.job_id);

        if (jobRes.changes !== 1) {
          throw new FencingRollbackError("Job status mismatch during outbox completion");
        }

        const reportRes = this.database.prepare(`
          UPDATE reports SET github_comment_status = ?, github_comment_error = NULL WHERE job_id = ?
        `).run(status, outboxItem.job_id);

        if (reportRes.changes !== 1) {
          throw new FencingRollbackError("Report row not found during outbox completion");
        }

        return true;
      })();
    } catch (caught) {
      if (caught instanceof FencingRollbackError) {
        return false;
      }
      throw caught;
    }
  }

  markPublishOutboxRetry(
    id: string,
    owner: string,
    leaseGeneration: number,
    error: string,
    backoffMs: number
  ): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const nextAttemptAtIso = new Date(now.getTime() + backoffMs).toISOString();
    const sanitizedError = error.slice(0, 500);

    try {
      return this.database.transaction(() => {
        const outboxRes = this.database.prepare(`
          UPDATE publish_outbox
          SET attempt_count = attempt_count + 1, status = 'retrying', next_attempt_at = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
        `).run(nextAttemptAtIso, sanitizedError, nowIso, id, owner, leaseGeneration);

        if (outboxRes.changes !== 1) {
          throw new FencingRollbackError("Outbox lease generation fencing token mismatch");
        }

        const outboxItem = this.database.prepare("SELECT job_id FROM publish_outbox WHERE id = ?").get(id) as { job_id: string } | undefined;
        if (!outboxItem) {
          throw new FencingRollbackError("Outbox item not found");
        }

        const jobRes = this.database.prepare(`
          UPDATE jobs SET status = 'awaiting_publish', updated_at = ?
          WHERE id = ? AND status = 'publishing'
        `).run(nowIso, outboxItem.job_id);

        if (jobRes.changes !== 1) {
          throw new FencingRollbackError("Job status mismatch during outbox retry");
        }

        const reportRes = this.database.prepare(`
          UPDATE reports SET github_comment_status = 'pending', github_comment_error = ? WHERE job_id = ?
        `).run(sanitizedError, outboxItem.job_id);

        if (reportRes.changes !== 1) {
          throw new FencingRollbackError("Report row not found during outbox retry");
        }

        return true;
      })();
    } catch (caught) {
      if (caught instanceof FencingRollbackError) {
        return false;
      }
      throw caught;
    }
  }

  markPublishOutboxFailed(
    id: string,
    owner: string,
    leaseGeneration: number,
    error: string
  ): boolean {
    const nowIso = new Date().toISOString();
    const sanitizedError = error.slice(0, 500);

    try {
      return this.database.transaction(() => {
        const outboxRes = this.database.prepare(`
          UPDATE publish_outbox
          SET attempt_count = attempt_count + 1, status = 'failed', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
        `).run(sanitizedError, nowIso, id, owner, leaseGeneration);

        if (outboxRes.changes !== 1) {
          throw new FencingRollbackError("Outbox lease generation fencing token mismatch");
        }

        const outboxItem = this.database.prepare("SELECT job_id FROM publish_outbox WHERE id = ?").get(id) as { job_id: string } | undefined;
        if (!outboxItem) {
          throw new FencingRollbackError("Outbox item not found");
        }

        const jobRes = this.database.prepare(`
          UPDATE jobs SET status = 'publish_failed', error = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'publishing'
        `).run(sanitizedError, nowIso, nowIso, outboxItem.job_id);

        if (jobRes.changes !== 1) {
          throw new FencingRollbackError("Job status mismatch during outbox failure");
        }

        const reportRes = this.database.prepare(`
          UPDATE reports SET github_comment_status = 'failed', github_comment_error = ? WHERE job_id = ?
        `).run(sanitizedError, outboxItem.job_id);

        if (reportRes.changes !== 1) {
          throw new FencingRollbackError("Report row not found during outbox failure");
        }

        return true;
      })();
    } catch (caught) {
      if (caught instanceof FencingRollbackError) {
        return false;
      }
      throw caught;
    }
  }

  updateStatus(id: string, status: JobStatus, error?: string): ReviewJob | undefined {
    if (status === "running") return this.markRunning(id);
    if (status === "failed") return this.markFailed(id, error ?? "Job failed");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, now, id);
    return this.get(id);
  }

  acceptWebhookJob(input: WebhookJobInput): WebhookAcceptance {
    return this.database.transaction(() => {
      const receivedAt = new Date().toISOString();
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, received_at, status)
        VALUES (?, ?, ?, ?, 'enqueued')
      `).run(input.delivery.deliveryId, input.delivery.event, input.delivery.action ?? null, receivedAt);
      if (inserted.changes === 0) {
        return { duplicate: true, delivery: this.getWebhookDelivery(input.delivery.deliveryId)! };
      }

      const job = this.enqueue({
        ...input.job,
        deliveryId: input.delivery.deliveryId
      });

      return { duplicate: false, delivery: this.getWebhookDelivery(input.delivery.deliveryId)!, job };
    })();
  }

  recordWebhookDelivery(input: Omit<WebhookDelivery, "receivedAt"> & { receivedAt?: string }): WebhookAcceptance {
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, received_at, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.deliveryId, input.event, input.action ?? null, receivedAt, input.status);

    if (inserted.changes === 0) {
      return { duplicate: true, delivery: this.getWebhookDelivery(input.deliveryId)! };
    }
    return { duplicate: false, delivery: this.getWebhookDelivery(input.deliveryId)! };
  }

  getWebhookDelivery(deliveryId: string): WebhookDelivery | undefined {
    const row = this.database.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?").get(deliveryId) as any;
    if (!row) return undefined;
    return {
      deliveryId: row.delivery_id,
      event: row.event,
      action: row.action ?? undefined,
      receivedAt: row.received_at,
      status: row.status
    };
  }

  saveAgentRun(agentRun: AgentRun): void {
    const validated = agentRunSchema.parse(agentRun);
    this.database.prepare(`
      INSERT INTO agent_runs (
        id, job_id, agent_name, status, started_at, finished_at,
        input_summary, findings_json, error, token_usage_json, provider, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        finished_at = excluded.finished_at,
        findings_json = excluded.findings_json,
        error = excluded.error,
        token_usage_json = excluded.token_usage_json,
        provider = excluded.provider,
        model = excluded.model
    `).run(
      validated.id,
      validated.jobId,
      validated.agentName,
      validated.status,
      validated.startedAt,
      validated.finishedAt ?? null,
      validated.inputSummary,
      JSON.stringify(validated.findings),
      validated.error ?? null,
      validated.tokenUsage ? JSON.stringify(validated.tokenUsage) : null,
      validated.provider ?? null,
      validated.model ?? null
    );
  }

  listAgentRuns(jobId: string): AgentRun[] {
    const rows = this.database.prepare("SELECT * FROM agent_runs WHERE job_id = ? ORDER BY started_at ASC").all(jobId) as any[];
    return rows.map(row => agentRunSchema.parse({
      id: row.id,
      jobId: row.job_id,
      agentName: row.agent_name,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      inputSummary: row.input_summary,
      findings: JSON.parse(row.findings_json),
      error: row.error ?? undefined,
      tokenUsage: row.token_usage_json ? JSON.parse(row.token_usage_json) : undefined,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined
    }));
  }

  recoverStaleRunningJobs(cutoff: Date): number {
    const cutoffIso = cutoff.toISOString();
    const result = this.database.prepare(`
      UPDATE jobs
      SET status = 'failed', error = 'Job execution timed out while running', updated_at = ?
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
    `).run(new Date().toISOString(), cutoffIso);
    return result.changes;
  }

  updateReportCommentStatus(jobId: string, status: GitHubCommentStatus, error?: string): void {
    this.database.prepare(`
      UPDATE reports
      SET github_comment_status = ?, github_comment_error = ?
      WHERE job_id = ?
    `).run(status, error ?? null, jobId);
  }

  private rowToJob(row: any): ReviewJob {
    const reportJson = Object.prototype.hasOwnProperty.call(row, "report_json")
      ? row.report_json as string | null
      : (this.database.prepare("SELECT report_json FROM reports WHERE job_id = ?").get(row.id) as { report_json: string } | undefined)?.report_json;
    const report = reportJson ? reviewReportSchema.parse(JSON.parse(reportJson)) : undefined;

    return {
      id: row.id,
      kind: row.type === "PR_REVIEW" ? "pull_request" : "push",
      status: row.status,
      deliveryId: row.delivery_id ?? undefined,
      repository: row.repository_full_name,
      repositoryId: row.repository_id ?? undefined,
      repoPath: row.repo_path ?? undefined,
      installationId: row.installation_id ?? undefined,
      accessMode: row.access_mode === "public_read" || row.access_mode === "local_git"
        ? row.access_mode
        : "github_app",
      senderLogin: row.sender_login ?? undefined,
      action: row.action ?? undefined,
      pullRequestNumber: row.pull_request_number ?? undefined,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      publicationPolicy: row.publication_policy === "disabled" ? "disabled" : "github_comment",
      llmProvider: (row.llm_provider as "deepseek" | "openai" | undefined) ?? (report?.llmProvider as "deepseek" | "openai" | undefined) ?? undefined,
      llmModel: (row.llm_model as string | undefined) ?? report?.llmModel ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      result: report,
      error: row.error ?? undefined
    };
  }
}
