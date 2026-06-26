import { randomUUID } from "node:crypto";
import {
  agentRunSchema,
  reviewReportSchema,
  type AgentRun,
  type ReviewReport
} from "@consistency/schema";
import type { ConsistencyDatabase } from "../db/connection";
import type {
  CreateReviewJobInput,
  GitHubCommentStatus,
  JobStatus,
  ReviewJob,
  ReviewJobStore,
  WebhookAcceptance,
  WebhookDelivery,
  WebhookJobInput
} from "../jobQueue";

type JobRow = {
  id: string;
  status: JobStatus;
  repository_full_name: string;
  pull_request_number: number;
  installation_id: number | null;
  base_sha: string;
  head_sha: string;
  delivery_id: string | null;
  sender_login: string | null;
  action: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  report_json: string | null;
};

type DeliveryRow = {
  delivery_id: string;
  event: string;
  action: string | null;
  received_at: string;
  status: WebhookDelivery["status"];
};

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function deliveryFromRow(row: DeliveryRow): WebhookDelivery {
  return {
    deliveryId: row.delivery_id,
    event: row.event,
    action: optional(row.action),
    receivedAt: row.received_at,
    status: row.status
  };
}

export class SQLiteJobStore implements ReviewJobStore {
  constructor(private readonly database: ConsistencyDatabase) {}

  private rowForJob(id: string): JobRow | undefined {
    return this.database.prepare(`
      SELECT jobs.*, reports.report_json
      FROM jobs
      LEFT JOIN reports ON reports.job_id = jobs.id
      WHERE jobs.id = ?
    `).get(id) as JobRow | undefined;
  }

  private jobFromRow(row: JobRow): ReviewJob {
    return {
      id: row.id,
      kind: "pull_request",
      status: row.status as Exclude<JobStatus, "cancelled">,
      deliveryId: row.delivery_id ?? `manual:${row.id}`,
      repository: row.repository_full_name,
      pullRequestNumber: row.pull_request_number,
      installationId: optional(row.installation_id),
      baseSha: row.base_sha,
      headSha: row.head_sha,
      senderLogin: optional(row.sender_login),
      action: optional(row.action),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: optional(row.started_at),
      finishedAt: optional(row.finished_at),
      error: optional(row.error),
      result: row.report_json ? reviewReportSchema.parse(JSON.parse(row.report_json)) : undefined
    };
  }

  enqueue(input: CreateReviewJobInput): ReviewJob {
    if (input.kind !== "pull_request" || !input.pullRequestNumber || !input.baseSha || !input.headSha) {
      throw new Error("SQLite job store only accepts complete pull request review jobs");
    }
    const id = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO jobs (
        id, type, status, repository_full_name, pull_request_number, installation_id,
        base_sha, head_sha, delivery_id, sender_login, action, created_at, updated_at
      ) VALUES (?, 'PR_REVIEW', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.repository,
      input.pullRequestNumber,
      input.installationId ?? null,
      input.baseSha,
      input.headSha,
      input.deliveryId.startsWith("manual:") ? null : input.deliveryId,
      input.senderLogin ?? null,
      input.action ?? null,
      now,
      now
    );
    return this.get(id)!;
  }

  list(): ReviewJob[] {
    const rows = this.database.prepare(`
      SELECT jobs.*, reports.report_json
      FROM jobs
      LEFT JOIN reports ON reports.job_id = jobs.id
      ORDER BY jobs.created_at ASC
    `).all() as JobRow[];
    return rows.map(row => this.jobFromRow(row));
  }

  get(id: string): ReviewJob | undefined {
    const row = this.rowForJob(id);
    return row ? this.jobFromRow(row) : undefined;
  }

  nextQueued(): ReviewJob | undefined {
    const row = this.database.prepare(`
      SELECT jobs.*, reports.report_json
      FROM jobs
      LEFT JOIN reports ON reports.job_id = jobs.id
      WHERE jobs.status = 'queued'
      ORDER BY jobs.created_at ASC
      LIMIT 1
    `).get() as JobRow | undefined;
    return row ? this.jobFromRow(row) : undefined;
  }

  claimNextQueued(): ReviewJob | undefined {
    return this.database.transaction(() => {
      const queued = this.database.prepare(`
        SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
      `).get() as { id: string } | undefined;
      if (!queued) return undefined;
      const now = new Date().toISOString();
      const claimed = this.database.prepare(`
        UPDATE jobs SET status = 'running', started_at = ?, updated_at = ?, error = NULL
        WHERE id = ? AND status = 'queued'
      `).run(now, now, queued.id);
      return claimed.changes === 1 ? this.get(queued.id) : undefined;
    })();
  }

  markRunning(id: string): ReviewJob | undefined {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?),
        finished_at = NULL, updated_at = ?, error = NULL
      WHERE id = ?
    `).run(now, now, id);
    return this.get(id);
  }

  markSucceeded(id: string, result: ReviewReport): ReviewJob | undefined {
    const report = reviewReportSchema.parse(result);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO reports (id, job_id, report_json, created_at, github_comment_status)
        VALUES (?, ?, ?, ?, 'pending')
        ON CONFLICT(job_id) DO UPDATE SET report_json = excluded.report_json, created_at = excluded.created_at
      `).run(`report_${randomUUID()}`, id, JSON.stringify(report), report.createdAt);
      this.database.prepare(`
        UPDATE jobs SET status = 'succeeded', finished_at = ?, updated_at = ?, error = NULL WHERE id = ?
      `).run(now, now, id);
    })();
    return this.get(id);
  }

  markFailed(id: string, error: string): ReviewJob | undefined {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?
    `).run(error, now, now, id);
    return this.get(id);
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
      const job = this.enqueue({ ...input.job, deliveryId: input.delivery.deliveryId });
      return {
        duplicate: false,
        delivery: { ...input.delivery, receivedAt, status: "enqueued" as const },
        job
      };
    })();
  }

  recordWebhookDelivery(
    input: Omit<WebhookDelivery, "receivedAt"> & { receivedAt?: string }
  ): WebhookAcceptance {
    const delivery = { ...input, receivedAt: input.receivedAt ?? new Date().toISOString() };
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, received_at, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(delivery.deliveryId, delivery.event, delivery.action ?? null, delivery.receivedAt, delivery.status);
    if (inserted.changes === 0) {
      return { duplicate: true, delivery: this.getWebhookDelivery(input.deliveryId)! };
    }
    return { duplicate: false, delivery };
  }

  getWebhookDelivery(deliveryId: string): WebhookDelivery | undefined {
    const row = this.database.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : undefined;
  }

  saveAgentRun(input: AgentRun): void {
    const agentRun = agentRunSchema.parse(input);
    this.database.prepare(`
      INSERT INTO agent_runs (
        id, job_id, agent_name, status, started_at, finished_at,
        input_summary, findings_json, error, token_usage_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, finished_at = excluded.finished_at,
        input_summary = excluded.input_summary, findings_json = excluded.findings_json,
        error = excluded.error, token_usage_json = excluded.token_usage_json
    `).run(
      agentRun.id,
      agentRun.jobId,
      agentRun.agentName,
      agentRun.status,
      agentRun.startedAt,
      agentRun.finishedAt ?? null,
      agentRun.inputSummary,
      JSON.stringify(agentRun.findings),
      agentRun.error ?? null,
      agentRun.tokenUsage ? JSON.stringify(agentRun.tokenUsage) : null
    );
  }

  listAgentRuns(jobId: string): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM agent_runs WHERE job_id = ? ORDER BY started_at ASC
    `).all(jobId) as Array<{
      id: string; job_id: string; agent_name: AgentRun["agentName"]; status: AgentRun["status"];
      started_at: string; finished_at: string | null; input_summary: string; findings_json: string;
      error: string | null; token_usage_json: string | null;
    }>;
    return rows.map(row => agentRunSchema.parse({
      id: row.id,
      jobId: row.job_id,
      agentName: row.agent_name,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: optional(row.finished_at),
      inputSummary: row.input_summary,
      findings: JSON.parse(row.findings_json),
      error: optional(row.error),
      tokenUsage: row.token_usage_json ? JSON.parse(row.token_usage_json) : undefined
    }));
  }

  recoverStaleRunningJobs(cutoff: Date): number {
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'queued', started_at = NULL, finished_at = NULL,
        updated_at = ?, error = 'Recovered after an interrupted worker run'
      WHERE status = 'running' AND started_at < ?
    `).run(new Date().toISOString(), cutoff.toISOString());
    return result.changes;
  }

  updateReportCommentStatus(jobId: string, status: GitHubCommentStatus, error?: string): void {
    this.database.prepare(`
      UPDATE reports SET github_comment_status = ?, github_comment_error = ? WHERE job_id = ?
    `).run(status, error ?? null, jobId);
  }
}
