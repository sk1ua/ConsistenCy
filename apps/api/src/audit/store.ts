import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AUDIT_DRAFT_ONLY_EXECUTION_REASON,
  automationScheduleStateSchema,
  automationScheduleWindowSchema,
  auditIssueSchema,
  auditReportV2Schema,
  auditRunEventSchema,
  auditRunPlanningReceiptSchema,
  auditRunPlanningResultSchema,
  auditRunSchema,
  automationSchema,
  createAuditIssueRequestSchema,
  createAuditRunRequestSchema,
  createAutomationRequestSchema,
  createPolicyRevisionRequestSchema,
  createRepositoryRequestSchema,
  createWorkflowRevisionRequestSchema,
  evolutionSnapshotSchema,
  findingOccurrenceSchema,
  heartbeatPulseSchema,
  planAuditRunDraftRequestSchema,
  policyRevisionSchema,
  repositoryEventSchema,
  repositoryPulseSchema,
  repositorySchema,
  runStepArtifactSchema,
  workflowRevisionSchema,
  type AuditIssue,
  type AuditIssueAction,
  type AuditReportV2,
  type AuditRun,
  type AuditRunEvent,
  type AuditRunEventType,
  type AuditRunPlanningReceipt,
  type AuditRunPlanningResult,
  type Automation,
  type AutomationScheduleState,
  type AutomationScheduleWindow,
  type CreateAuditIssueRequest,
  type CreateAuditRunRequest,
  type CreateAutomationRequest,
  type CreatePolicyRevisionRequest,
  type CreateRepositoryRequest,
  type CreateWorkflowRevisionRequest,
  type EvolutionSnapshot,
  type FindingOccurrence,
  type PolicyRevision,
  type PlanAuditRunDraftRequest,
  type Repository,
  type RepositoryEvent,
  type RepositoryPulse,
  type RepositoryTrustLevel,
  type RunStepArtifact,
  type WorkflowRevision,
  type HeartbeatPulse
} from "@consistency/schema";
import type { ConsistencyDatabase } from "../db/connection";
import type { WorkflowRuntimeStore } from "../workflow-runtime/store";
import { containsSensitiveData, sanitizeExecutionError, sanitizePublicError, sanitizeStructuredData } from "../security/redact";

export class AuditDomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "AuditDomainError";
  }
}

/**
 * Minimal write-time gate used to validate an automation's optional
 * workflow-runtime definition mapping. Structurally satisfied by
 * WorkflowRuntimeStore; tests may inject a bounded fake.
 */
export type WorkflowRuntimeDefinitionGate = Pick<
  WorkflowRuntimeStore,
  "definitionExists" | "getLatestValidatedRevision"
>;

export type SQLiteAuditDomainStoreOptions = {
  /** When absent, creating/updating a runtime-mapped automation fails closed. */
  workflowRuntime?: WorkflowRuntimeDefinitionGate;
  /**
   * Executor-slice availability computation for planned drafts. When absent
   * the store keeps the honest draft-only fallback ({ available: false } with
   * AUDIT_DRAFT_ONLY_EXECUTION_REASON); the composition root injects a
   * resolver that answers executor-enabled × automation-mapped × repository-local.
   */
  resolveExecutionAvailability?: AuditExecutionAvailabilityResolver;
};

/** Computed `execution` block of an audit-run planning result. */
export type AuditExecutionAvailability = AuditRunPlanningResult["execution"];

export type AuditExecutionAvailabilityResolver = (subject: {
  repositoryId: string;
  automationId: string;
}) => AuditExecutionAvailability;

export type MarkAuditRunTransitionOptions = {
  /** Immutable link to the executing workflow-runtime run. */
  workflowRuntimeRunId?: string;
  /** Terminal failure detail (stored in the dedicated execution_error column). */
  executionError?: string;
};

export type RegisterRepositoryOptions = {
  /** Server-only checkout or provider locator. Never returned in Repository. */
  serverLocator?: string;
  trustLevel?: RepositoryTrustLevel;
};

/** Server-only projection used to compose local repository supervision. */
export type LocalRepositorySupervisionTarget = {
  repository: Repository;
  serverLocator: string;
};

export type CompleteAutomationScheduleWindowInput = {
  /** Compare-and-set guard against another scheduler instance advancing first. */
  expectedScheduledFor: string;
  window: AutomationScheduleWindow;
  nextScheduledAt: string;
};

export type ConnectGitHubRepositoryOptions = {
  /** Existing pre-verification row selected by the requested canonical identity. */
  existingRepositoryId?: string;
};

export interface AuditDomainStore {
  listRepositories(): Repository[];
  getRepository(id: string): Repository | undefined;
  findRepositoryByRemoteFullName(remoteFullName: string): Repository | undefined;
  getLocalRepositoryPath?(id: string): string | undefined;
  createRepository(input: CreateRepositoryRequest, options?: RegisterRepositoryOptions): Repository;
  registerLocalRepository(input: CreateRepositoryRequest, options: RegisterRepositoryOptions & { serverLocator: string }): Repository;
  connectGitHubRepository(input: CreateRepositoryRequest, options?: ConnectGitHubRepositoryOptions): Repository;
  setRepositoryMonitoring(id: string, enabled: boolean): Repository;
  listLocalRepositorySupervisionTargets(): LocalRepositorySupervisionTarget[];
  listRepositoryEvents(repositoryId?: string): RepositoryEvent[];
  getRepositoryEvent(id: string): RepositoryEvent | undefined;
  saveRepositoryEvent(event: RepositoryEvent): RepositoryEvent;
  listRepositoryPulses(repositoryId: string, limit?: number): RepositoryPulse[];
  saveRepositoryPulse(repositoryId: string, pulse: HeartbeatPulse): RepositoryPulse;

  listWorkflowRevisions(workflowId?: string): WorkflowRevision[];
  getWorkflowRevision(id: string): WorkflowRevision | undefined;
  createWorkflowRevision(input: CreateWorkflowRevisionRequest): WorkflowRevision;
  listPolicyRevisions(policyId?: string): PolicyRevision[];
  getPolicyRevision(id: string): PolicyRevision | undefined;
  createPolicyRevision(input: CreatePolicyRevisionRequest): PolicyRevision;

  listAutomations(repositoryId?: string): Automation[];
  getAutomation(id: string): Automation | undefined;
  createAutomation(input: CreateAutomationRequest): Automation;
  /** Full-row replacement following the create request schema (runtime bridge). */
  updateAutomation(id: string, input: CreateAutomationRequest): Automation;
  setAutomationEnabled(id: string, enabled: boolean): Automation;

  listAuditRuns(repositoryId?: string): AuditRun[];
  /** Active rows that must be reconciled after crashes, including unlinked queued rows. */
  listRecoverableAuditRuns(limit?: number): AuditRun[];
  getAuditRun(id: string): AuditRun | undefined;
  createAuditRunDraft(input: CreateAuditRunRequest): AuditRun;
  markRunQueued(runId: string, options?: MarkAuditRunTransitionOptions): AuditRun;
  markRunRunning(runId: string, options?: MarkAuditRunTransitionOptions): AuditRun;
  markRunTerminal(
    runId: string,
    status: Extract<AuditRun["status"], "succeeded" | "failed">,
    options?: MarkAuditRunTransitionOptions
  ): AuditRun;
  /** Controlled recovery transition for a queued run that cannot be launched. */
  markRunFailedFromQueued(runId: string, options?: MarkAuditRunTransitionOptions): AuditRun;
  listRunEvents(runId: string): AuditRunEvent[];
  listAuditRunPlanningReceipts(automationId?: string): AuditRunPlanningReceipt[];
  planAuditRunDraft(input: PlanAuditRunDraftRequest): AuditRunPlanningResult;
  getAutomationScheduleState(automationId: string): AutomationScheduleState | undefined;
  ensureAutomationScheduleState(state: AutomationScheduleState): AutomationScheduleState;
  listAutomationScheduleWindows(automationId: string): AutomationScheduleWindow[];
  completeAutomationScheduleWindow(input: CompleteAutomationScheduleWindowInput): AutomationScheduleWindow | undefined;
  cancelAuditRun(id: string): AuditRun;
  listRunStepArtifacts(auditRunId: string): RunStepArtifact[];
  saveRunStepArtifact(artifact: RunStepArtifact): RunStepArtifact;

  listIssues(repositoryId?: string, state?: AuditIssue["state"]): AuditIssue[];
  getIssue(id: string): AuditIssue | undefined;
  createIssue(input: CreateAuditIssueRequest): AuditIssue;
  applyIssueAction(id: string, action: AuditIssueAction, reason?: string): AuditIssue;
  saveFindingOccurrence(occurrence: FindingOccurrence): FindingOccurrence;

  listEvolutionSnapshots(repositoryId: string): EvolutionSnapshot[];
  saveEvolutionSnapshot(snapshot: EvolutionSnapshot): EvolutionSnapshot;
  getAuditReport(auditRunId: string): AuditReportV2 | undefined;
  saveAuditReport(report: AuditReportV2): AuditReportV2;
}

function now(): string {
  return new Date().toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable planner identity for a runtime definition without inventing a legacy revision. */
function runtimeWorkflowDigest(definitionId: string): string {
  return digest(`runtime:${definitionId}`);
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function assertFound<T>(value: T | undefined, noun: string): T {
  if (value === undefined) throw new AuditDomainError(`${noun} not found`, "AUDIT_DOMAIN_NOT_FOUND", 404);
  return value;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/** Bounded positive LIMIT for executor queue reads. */
function normalizeQueryLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 25;
}

export class SQLiteAuditDomainStore implements AuditDomainStore {
  private readonly workflowRuntimeGate?: WorkflowRuntimeDefinitionGate;
  private readonly resolveExecutionAvailability?: AuditExecutionAvailabilityResolver;

  constructor(
    private readonly database: ConsistencyDatabase,
    options: SQLiteAuditDomainStoreOptions = {}
  ) {
    this.workflowRuntimeGate = options.workflowRuntime;
    this.resolveExecutionAvailability = options.resolveExecutionAvailability;
  }

  /**
   * Executor-slice claim queue: durable drafts whose automation carries a
   * workflow-runtime definition mapping, oldest first. Runs without a mapping
   * are structurally unexecutable and stay out of the drain (their planning
   * availability already reported the reason honestly).
   */
  listExecutableRuns(limit = 25): AuditRun[] {
    const rows = this.database.prepare(`
      SELECT ar.* FROM audit_runs ar
      JOIN automations au ON au.id = ar.automation_id
      WHERE ar.status = 'created' AND au.runtime_definition_id IS NOT NULL
      ORDER BY ar.created_at ASC, ar.id ASC
      LIMIT ?
    `).all(normalizeQueryLimit(limit)) as any[];
    return rows.map(row => this.auditRunFromRow(row));
  }

  /**
   * Executor-slice mirror queue: runs in flight through the workflow runtime
   * (running + immutable link), oldest started first.
   */
  listLinkedRunningRuns(limit = 50): AuditRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM audit_runs
      WHERE status = 'running' AND workflow_runtime_run_id IS NOT NULL
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    `).all(normalizeQueryLimit(limit)) as any[];
    return rows.map(row => this.auditRunFromRow(row));
  }

  listRecoverableAuditRuns(limit = 200): AuditRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM audit_runs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(normalizeQueryLimit(limit)) as any[];
    return rows.map(row => this.auditRunFromRow(row));
  }

  listRepositories(): Repository[] {
    const rows = this.database.prepare("SELECT * FROM repositories ORDER BY updated_at DESC, id ASC").all() as any[];
    return rows.map(row => this.repositoryFromRow(row));
  }

  getRepository(id: string): Repository | undefined {
    const row = this.database.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as any;
    return row === undefined ? undefined : this.repositoryFromRow(row);
  }

  findRepositoryByRemoteFullName(remoteFullName: string): Repository | undefined {
    return this.findRepositoriesByRemoteFullName(remoteFullName)[0];
  }

  private findRepositoriesByRemoteFullName(remoteFullName: string): Repository[] {
    const normalized = remoteFullName.trim().toLowerCase();
    if (!normalized) return [];
    const rows = this.database.prepare(`
      SELECT * FROM repositories
      WHERE source IN ('local_git', 'github')
        AND remote_full_name IS NOT NULL
        AND lower(remote_full_name) = ?
      ORDER BY CASE source WHEN 'local_git' THEN 0 ELSE 1 END, created_at ASC, id ASC
    `).all(normalized) as any[];
    return rows.map(row => this.repositoryFromRow(row));
  }

  private reconciliationConflict(): never {
    throw new AuditDomainError(
      "Repository identity requires explicit reconciliation",
      "REPOSITORY_RECONCILIATION_CONFLICT",
      409
    );
  }

  getLocalRepositoryPath(id: string): string | undefined {

    const row = this.database.prepare("SELECT server_locator FROM repositories WHERE id = ?").get(id) as any;
    return row?.server_locator ? String(row.server_locator) : undefined;
  }

  createRepository(input: CreateRepositoryRequest, options: RegisterRepositoryOptions = {}): Repository {
    const parsed = createRepositoryRequestSchema.parse(input);
    const createdAt = now();
    const id = `repo_${randomUUID()}`;
    const trustLevel = parsed.source === "local_git" && options.trustLevel === "trusted_local"
      ? "trusted_local"
      : "untrusted_readonly";
    const serverLocator = options.serverLocator === undefined ? undefined : resolve(options.serverLocator);
    if (parsed.source === "local_git" && serverLocator === undefined) {
      throw new AuditDomainError(
        "Local repository registration requires a server-side locator",
        "LOCAL_REPOSITORY_LOCATOR_REQUIRED",
        400
      );
    }
    const identityKey = parsed.source === "local_git"
      ? `local:${serverLocator}`
      : `${parsed.source}:${parsed.remoteFullName!.toLowerCase()}`;

    try {
      this.database.prepare(`
        INSERT INTO repositories (
          id, display_name, source, identity_key, server_locator,
          remote_full_name, default_branch, trust_level,
          monitoring_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parsed.displayName,
        parsed.source,
        identityKey,
        serverLocator ?? null,
        parsed.remoteFullName ?? null,
        parsed.defaultBranch ?? null,
        trustLevel,
        parsed.monitoringEnabled ? 1 : 0,
        createdAt,
        createdAt
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AuditDomainError("Repository is already registered", "REPOSITORY_ALREADY_EXISTS", 409);
      }
      throw error;
    }
    return assertFound(this.getRepository(id), "Repository");
  }

  registerLocalRepository(
    input: CreateRepositoryRequest,
    options: RegisterRepositoryOptions & { serverLocator: string }
  ): Repository {
    const parsed = createRepositoryRequestSchema.parse(input);
    if (parsed.source !== "local_git") {
      throw new AuditDomainError("Expected a local Git repository", "LOCAL_REPOSITORY_SOURCE_REQUIRED", 400);
    }
    const serverLocator = resolve(options.serverLocator);
    const localIdentityKey = `local:${serverLocator}`;
    const trustLevel = options.trustLevel === "trusted_local" ? "trusted_local" : "untrusted_readonly";

    return this.database.transaction(() => {
      const existingPath = this.database.prepare("SELECT id FROM repositories WHERE identity_key = ?")
        .get(localIdentityKey) as { id: string } | undefined;
      if (existingPath !== undefined) {
        const existing = assertFound(this.getRepository(existingPath.id), "Repository");
        if (
          existing.remoteFullName !== undefined
          && parsed.remoteFullName !== undefined
          && existing.remoteFullName.toLowerCase() !== parsed.remoteFullName.toLowerCase()
        ) {
          return this.reconciliationConflict();
        }
        const remoteFullName = existing.remoteFullName ?? parsed.remoteFullName;
        if (
          remoteFullName !== undefined
          && this.findRepositoriesByRemoteFullName(remoteFullName).some(repository => repository.id !== existing.id)
        ) {
          return this.reconciliationConflict();
        }
        this.database.prepare(`
          UPDATE repositories SET
            display_name = ?, remote_full_name = ?, default_branch = ?, trust_level = ?,
            monitoring_enabled = ?, updated_at = ?
          WHERE id = ?
        `).run(
          parsed.displayName,
          remoteFullName ?? null,
          existing.defaultBranch ?? parsed.defaultBranch ?? null,
          options.trustLevel ?? existing.trustLevel,
          parsed.monitoringEnabled ? 1 : 0,
          now(),
          existing.id
        );
        return assertFound(this.getRepository(existing.id), "Repository");
      }

      const matchingRemote = parsed.remoteFullName === undefined
        ? undefined
        : this.findRepositoryByRemoteFullName(parsed.remoteFullName);
      if (matchingRemote?.source === "local_git") return this.reconciliationConflict();
      if (matchingRemote !== undefined) {
        this.database.prepare(`
          UPDATE repositories SET
            display_name = ?, source = 'local_git', identity_key = ?, server_locator = ?,
            remote_full_name = ?, default_branch = ?, trust_level = ?, monitoring_enabled = ?, updated_at = ?
          WHERE id = ?
        `).run(
          parsed.displayName,
          localIdentityKey,
          serverLocator,
          parsed.remoteFullName ?? matchingRemote.remoteFullName ?? null,
          matchingRemote.defaultBranch ?? parsed.defaultBranch ?? null,
          trustLevel,
          parsed.monitoringEnabled ? 1 : 0,
          now(),
          matchingRemote.id
        );
        return assertFound(this.getRepository(matchingRemote.id), "Repository");
      }
      return this.createRepository(parsed, { ...options, serverLocator });
    })();
  }

  connectGitHubRepository(
    input: CreateRepositoryRequest,
    options: ConnectGitHubRepositoryOptions = {}
  ): Repository {
    const parsed = createRepositoryRequestSchema.parse(input);
    if (parsed.source !== "github" || parsed.remoteFullName === undefined) {
      throw new AuditDomainError("Expected a GitHub repository", "GITHUB_REPOSITORY_SOURCE_REQUIRED", 400);
    }
    const remoteFullName = parsed.remoteFullName;

    return this.database.transaction(() => {
      const canonicalMatches = this.findRepositoriesByRemoteFullName(remoteFullName);
      const selected = options.existingRepositoryId === undefined
        ? canonicalMatches[0]
        : this.getRepository(options.existingRepositoryId);
      if (
        selected !== undefined
        && selected.source !== "local_git"
        && selected.source !== "github"
      ) {
        return this.reconciliationConflict();
      }
      if (
        options.existingRepositoryId !== undefined
        && (
          selected === undefined
          || canonicalMatches.some(repository => repository.id !== options.existingRepositoryId)
        )
      ) {
        return this.reconciliationConflict();
      }
      if (selected !== undefined) {
        const providerIdentityKey = `github:${remoteFullName.toLowerCase()}`;
        if (selected.source === "github") {
          const identityCollision = this.database.prepare(`
            SELECT id FROM repositories WHERE identity_key = ? AND id <> ? LIMIT 1
          `).get(providerIdentityKey, selected.id) as { id: string } | undefined;
          if (identityCollision !== undefined) return this.reconciliationConflict();
        }
        this.database.prepare(`
          UPDATE repositories SET
            display_name = ?, remote_full_name = ?, default_branch = ?,
            identity_key = CASE WHEN source = 'github' THEN ? ELSE identity_key END,
            updated_at = ?
          WHERE id = ?
        `).run(
          parsed.displayName,
          remoteFullName,
          parsed.defaultBranch ?? selected.defaultBranch ?? null,
          providerIdentityKey,
          now(),
          selected.id
        );
        return assertFound(this.getRepository(selected.id), "Repository");
      }
      return this.createRepository(parsed);
    })();
  }

  setRepositoryMonitoring(id: string, enabled: boolean): Repository {

    const updatedAt = now();
    const result = this.database.prepare(`
      UPDATE repositories SET monitoring_enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, updatedAt, id);
    if (result.changes !== 1) throw new AuditDomainError("Repository not found", "REPOSITORY_NOT_FOUND", 404);
    return assertFound(this.getRepository(id), "Repository");
  }

  listLocalRepositorySupervisionTargets(): LocalRepositorySupervisionTarget[] {
    const rows = this.database.prepare(`
      SELECT * FROM repositories
      WHERE source = 'local_git'
        AND monitoring_enabled = 1
        AND server_locator IS NOT NULL
      ORDER BY updated_at DESC, id ASC
    `).all() as any[];
    return rows.map(row => ({
      repository: this.repositoryFromRow(row),
      serverLocator: String(row.server_locator)
    }));
  }

  listRepositoryEvents(repositoryId?: string): RepositoryEvent[] {
    const rows = (repositoryId === undefined
      ? this.database.prepare("SELECT * FROM repository_events ORDER BY occurred_at DESC, id ASC").all()
      : this.database.prepare("SELECT * FROM repository_events WHERE repository_id = ? ORDER BY occurred_at DESC, id ASC").all(repositoryId)) as any[];
    return rows.map(row => this.repositoryEventFromRow(row));
  }

  getRepositoryEvent(id: string): RepositoryEvent | undefined {
    const row = this.database.prepare("SELECT * FROM repository_events WHERE id = ?").get(id) as any;
    return row === undefined ? undefined : this.repositoryEventFromRow(row);
  }

  saveRepositoryEvent(input: RepositoryEvent): RepositoryEvent {
    const validated = repositoryEventSchema.parse(input);
    const event = repositoryEventSchema.parse(sanitizeStructuredData(validated));
    assertFound(this.getRepository(event.repositoryId), "Repository");
    try {
      this.database.prepare(`
        INSERT INTO repository_events (
          id, repository_id, type, source, dedupe_key, occurred_at,
          base_revision, head_revision, changed_files_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.repositoryId,
        event.type,
        event.source,
        event.dedupeKey,
        event.occurredAt,
        event.baseRevision ?? null,
        event.headRevision ?? null,
        JSON.stringify(event.changedFiles),
        JSON.stringify(event.metadata)
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const existingRow = this.database.prepare(`
          SELECT * FROM repository_events WHERE repository_id = ? AND dedupe_key = ?
        `).get(event.repositoryId, event.dedupeKey) as any;
        if (existingRow !== undefined) {
          const existing = this.repositoryEventFromRow(existingRow);
          if (
            digest({ ...existing, id: undefined, occurredAt: undefined })
            === digest({ ...event, id: undefined, occurredAt: undefined })
          ) return existing;
        }
        throw new AuditDomainError(
          "Repository event idempotency key conflicts with a different payload",
          "REPOSITORY_EVENT_CONFLICT",
          409
        );
      }
      throw error;
    }
    return event;
  }

  listRepositoryPulses(repositoryId: string, limit = 100): RepositoryPulse[] {
    assertFound(this.getRepository(repositoryId), "Repository");
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const safeLimit = Math.max(1, Math.min(500, normalizedLimit));
    const rows = this.database.prepare(`
      SELECT * FROM repository_pulses
      WHERE repository_id = ?
      ORDER BY observed_at DESC, pulse_id
      LIMIT ?
    `).all(repositoryId, safeLimit) as any[];
    return rows.map(row => this.repositoryPulseFromRow(row));
  }

  saveRepositoryPulse(repositoryId: string, input: HeartbeatPulse): RepositoryPulse {
    assertFound(this.getRepository(repositoryId), "Repository");
    const observed = heartbeatPulseSchema.parse(input);
    const pulse = repositoryPulseSchema.parse({
      pulseId: observed.pulseId,
      repositoryId,
      state: observed.state,
      observedAt: observed.observedAt,
      dirtyFileCount: observed.dirtyFileCount,
      pendingEvents: observed.pendingEvents,
      branch: observed.repository.branch,
      headRevision: observed.repository.headSha,
      metrics: observed.metrics === undefined ? undefined : sanitizeStructuredData(observed.metrics),
      lastError: observed.lastError === undefined
        ? undefined
        : sanitizePublicError(observed.lastError).slice(0, 2_000)
    });
    try {
      this.database.prepare(`
        INSERT INTO repository_pulses (
          pulse_id, repository_id, state, observed_at, dirty_file_count,
          pending_events, branch, head_revision, metrics_json, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pulse.pulseId,
        pulse.repositoryId,
        pulse.state,
        pulse.observedAt,
        pulse.dirtyFileCount,
        pulse.pendingEvents,
        pulse.branch ?? null,
        pulse.headRevision ?? null,
        pulse.metrics === undefined ? null : JSON.stringify(pulse.metrics),
        pulse.lastError ?? null
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const existingRow = this.database.prepare("SELECT * FROM repository_pulses WHERE pulse_id = ?")
          .get(pulse.pulseId) as any;
        if (existingRow !== undefined) {
          const existing = this.repositoryPulseFromRow(existingRow);
          if (digest(existing) === digest(pulse)) return existing;
        }
        throw new AuditDomainError(
          "Repository pulse id conflicts with a different payload",
          "REPOSITORY_PULSE_CONFLICT",
          409
        );
      }
      throw error;
    }
    return pulse;
  }

  listWorkflowRevisions(workflowId?: string): WorkflowRevision[] {
    const rows = (workflowId === undefined
      ? this.database.prepare("SELECT spec_json FROM workflow_revisions ORDER BY workflow_id, revision DESC").all()
      : this.database.prepare("SELECT spec_json FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision DESC").all(workflowId)) as Array<{ spec_json: string }>;
    return rows.map(row => workflowRevisionSchema.parse(parseJson(row.spec_json)));
  }

  getWorkflowRevision(id: string): WorkflowRevision | undefined {
    const row = this.database.prepare("SELECT spec_json FROM workflow_revisions WHERE id = ?").get(id) as { spec_json: string } | undefined;
    return row === undefined ? undefined : workflowRevisionSchema.parse(parseJson(row.spec_json));
  }

  createWorkflowRevision(input: CreateWorkflowRevisionRequest): WorkflowRevision {
    const parsed = createWorkflowRevisionRequestSchema.parse(input);
    // Legacy workflow specs are executable semantics. Fail closed rather than
    // sanitizing `with` and silently changing what a historical revision runs.
    if (containsSensitiveData(parsed.spec)) {
      throw new AuditDomainError(
        "Workflow revision contains sensitive data or a local absolute path",
        "WORKFLOW_REVISION_SENSITIVE_DATA",
        400,
      );
    }
    return this.database.transaction(() => {
      const specDigest = digest(parsed.spec);
      const existing = this.database.prepare(`
        SELECT spec_json FROM workflow_revisions WHERE workflow_id = ? AND digest = ?
      `).get(parsed.workflowId, specDigest) as { spec_json: string } | undefined;
      if (existing !== undefined) return workflowRevisionSchema.parse(parseJson(existing.spec_json));

      const row = this.database.prepare(`
        SELECT coalesce(max(revision), 0) + 1 AS revision FROM workflow_revisions WHERE workflow_id = ?
      `).get(parsed.workflowId) as { revision: number };
      const revision = workflowRevisionSchema.parse({
        id: `wfrev_${randomUUID()}`,
        workflowId: parsed.workflowId,
        revision: row.revision,
        digest: specDigest,
        spec: parsed.spec,
        createdAt: now()
      });
      this.database.prepare(`
        INSERT INTO workflow_revisions (id, workflow_id, revision, digest, spec_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(revision.id, revision.workflowId, revision.revision, revision.digest, JSON.stringify(revision), revision.createdAt);
      return revision;
    })();
  }

  listPolicyRevisions(policyId?: string): PolicyRevision[] {
    const rows = (policyId === undefined
      ? this.database.prepare("SELECT policy_json FROM policy_revisions ORDER BY policy_id, revision DESC").all()
      : this.database.prepare("SELECT policy_json FROM policy_revisions WHERE policy_id = ? ORDER BY revision DESC").all(policyId)) as Array<{ policy_json: string }>;
    return rows.map(row => policyRevisionSchema.parse(parseJson(row.policy_json)));
  }

  getPolicyRevision(id: string): PolicyRevision | undefined {
    const row = this.database.prepare("SELECT policy_json FROM policy_revisions WHERE id = ?").get(id) as { policy_json: string } | undefined;
    return row === undefined ? undefined : policyRevisionSchema.parse(parseJson(row.policy_json));
  }

  createPolicyRevision(input: CreatePolicyRevisionRequest): PolicyRevision {
    const parsed = createPolicyRevisionRequestSchema.parse(input);
    return this.database.transaction(() => {
      const policyDigest = digest(parsed);
      const existing = this.database.prepare(`
        SELECT policy_json FROM policy_revisions WHERE policy_id = ? AND digest = ?
      `).get(parsed.policyId, policyDigest) as { policy_json: string } | undefined;
      if (existing !== undefined) return policyRevisionSchema.parse(parseJson(existing.policy_json));

      const row = this.database.prepare(`
        SELECT coalesce(max(revision), 0) + 1 AS revision FROM policy_revisions WHERE policy_id = ?
      `).get(parsed.policyId) as { revision: number };
      const revision = policyRevisionSchema.parse({
        ...parsed,
        id: `policyrev_${randomUUID()}`,
        revision: row.revision,
        digest: policyDigest,
        createdAt: now()
      });
      this.database.prepare(`
        INSERT INTO policy_revisions (id, policy_id, revision, name, digest, policy_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(revision.id, revision.policyId, revision.revision, revision.name, revision.digest, JSON.stringify(revision), revision.createdAt);
      return revision;
    })();
  }

  listAutomations(repositoryId?: string): Automation[] {
    const rows = (repositoryId === undefined
      ? this.database.prepare("SELECT * FROM automations ORDER BY updated_at DESC, id ASC").all()
      : this.database.prepare("SELECT * FROM automations WHERE repository_id = ? ORDER BY updated_at DESC, id ASC").all(repositoryId)) as any[];
    return rows.map(row => this.automationFromRow(row));
  }

  getAutomation(id: string): Automation | undefined {
    const row = this.database.prepare("SELECT * FROM automations WHERE id = ?").get(id) as any;
    return row === undefined ? undefined : this.automationFromRow(row);
  }

  createAutomation(input: CreateAutomationRequest): Automation {
    const parsed = createAutomationRequestSchema.parse(input);
    const repository = assertFound(this.getRepository(parsed.repositoryId), "Repository");
    if (parsed.workflowRevisionId !== undefined) {
      assertFound(this.getWorkflowRevision(parsed.workflowRevisionId), "Workflow revision");
    }
    assertFound(this.getPolicyRevision(parsed.policyRevisionId), "Policy revision");
    if (parsed.runtimeDefinitionId !== undefined) {
      this.validateRuntimeDefinition(parsed.runtimeDefinitionId);
    }
    if (parsed.executionProfile === "trusted_sandbox" && repository.trustLevel !== "trusted_local") {
      throw new AuditDomainError(
        "trusted_sandbox requires an explicitly trusted local repository",
        "EXECUTION_PROFILE_NOT_ALLOWED",
        409
      );
    }
    return this.insertAutomation(parsed);
  }

  updateAutomation(id: string, input: CreateAutomationRequest): Automation {
    assertFound(this.getAutomation(id), "Automation");
    const parsed = createAutomationRequestSchema.parse(input);
    const repository = assertFound(this.getRepository(parsed.repositoryId), "Repository");
    if (parsed.workflowRevisionId !== undefined) {
      assertFound(this.getWorkflowRevision(parsed.workflowRevisionId), "Workflow revision");
    }
    assertFound(this.getPolicyRevision(parsed.policyRevisionId), "Policy revision");
    if (parsed.runtimeDefinitionId !== undefined) {
      this.validateRuntimeDefinition(parsed.runtimeDefinitionId);
    }
    if (parsed.executionProfile === "trusted_sandbox" && repository.trustLevel !== "trusted_local") {
      throw new AuditDomainError(
        "trusted_sandbox requires an explicitly trusted local repository",
        "EXECUTION_PROFILE_NOT_ALLOWED",
        409
      );
    }

    const nameCollision = this.database.prepare(`
      SELECT id FROM automations WHERE repository_id = ? AND name = ? AND id <> ?
    `).get(parsed.repositoryId, parsed.name, id) as { id: string } | undefined;
    if (nameCollision !== undefined) {
      throw new AuditDomainError("Automation name already exists for repository", "AUTOMATION_ALREADY_EXISTS", 409);
    }

    const automation = automationSchema.parse({
      ...parsed,
      id,
      updatedAt: now()
    });
    try {
      this.database.prepare(`
        UPDATE automations SET
          name = ?, trigger_json = ?, workflow_revision_id = ?,
          policy_revision_id = ?, execution_profile = ?, enabled = ?,
          runtime_definition_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        automation.name,
        JSON.stringify(automation.trigger),
        automation.workflowRevisionId ?? null,
        automation.policyRevisionId,
        automation.executionProfile,
        automation.enabled ? 1 : 0,
        automation.runtimeDefinitionId ?? null,
        automation.updatedAt,
        id
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AuditDomainError("Automation name already exists for repository", "AUTOMATION_ALREADY_EXISTS", 409);
      }
      throw error;
    }
    return assertFound(this.getAutomation(id), "Automation");
  }

  /**
   * Runtime mapping gate: a mapped definition must exist and have at least one
   * VALIDATED revision (same fail-closed order as WorkflowRuntimeHost's
   * binding-trigger gate, expressed with audit-store error semantics).
   */
  private validateRuntimeDefinition(definitionId: string): void {
    const gate = this.workflowRuntimeGate;
    if (gate === undefined) {
      throw new AuditDomainError(
        "Workflow-runtime definition validation is unavailable; wire the WorkflowRuntimeStore gate to map automations onto definitions",
        "AUTOMATION_RUNTIME_GATE_UNAVAILABLE",
        500
      );
    }
    if (!gate.definitionExists(definitionId)) {
      throw new AuditDomainError(
        `Workflow runtime definition '${definitionId}' does not exist`,
        "AUTOMATION_RUNTIME_DEFINITION_NOT_FOUND",
        404
      );
    }
    if (gate.getLatestValidatedRevision(definitionId) === undefined) {
      throw new AuditDomainError(
        `Workflow runtime definition '${definitionId}' has no validated revision`,
        "AUTOMATION_RUNTIME_REVISION_NOT_EXECUTABLE",
        409
      );
    }
  }

  private insertAutomation(parsed: CreateAutomationRequest): Automation {
    const createdAt = now();
    const automation = automationSchema.parse({
      ...parsed,
      id: `automation_${randomUUID()}`,
      createdAt,
      updatedAt: createdAt
    });
    try {
      this.database.prepare(`
        INSERT INTO automations (
          id, repository_id, name, trigger_json, workflow_revision_id,
          policy_revision_id, execution_profile, enabled, runtime_definition_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        automation.id,
        automation.repositoryId,
        automation.name,
        JSON.stringify(automation.trigger),
        automation.workflowRevisionId ?? null,
        automation.policyRevisionId,
        automation.executionProfile,
        automation.enabled ? 1 : 0,
        automation.runtimeDefinitionId ?? null,
        automation.createdAt,
        automation.updatedAt
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AuditDomainError("Automation name already exists for repository", "AUTOMATION_ALREADY_EXISTS", 409);
      }
      throw error;
    }
    return automation;
  }

  setAutomationEnabled(id: string, enabled: boolean): Automation {
    const result = this.database.prepare("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now(), id);
    if (result.changes !== 1) throw new AuditDomainError("Automation not found", "AUTOMATION_NOT_FOUND", 404);
    return assertFound(this.getAutomation(id), "Automation");
  }

  listAuditRuns(repositoryId?: string): AuditRun[] {
    const rows = (repositoryId === undefined
      ? this.database.prepare("SELECT * FROM audit_runs ORDER BY created_at DESC, id ASC").all()
      : this.database.prepare("SELECT * FROM audit_runs WHERE repository_id = ? ORDER BY created_at DESC, id ASC").all(repositoryId)) as any[];
    return rows.map(row => this.auditRunFromRow(row));
  }

  getAuditRun(id: string): AuditRun | undefined {
    const row = this.database.prepare("SELECT * FROM audit_runs WHERE id = ?").get(id) as any;
    return row === undefined ? undefined : this.auditRunFromRow(row);
  }

  createAuditRunDraft(input: CreateAuditRunRequest): AuditRun {
    const parsed = createAuditRunRequestSchema.parse(input);
    const repository = assertFound(this.getRepository(parsed.repositoryId), "Repository");
    assertFound(this.getPolicyRevision(parsed.policyRevisionId), "Policy revision");
    const automation = parsed.automationId === undefined
      ? undefined
      : assertFound(this.getAutomation(parsed.automationId), "Automation");
    if (parsed.workflowRevisionId !== undefined) {
      assertFound(this.getWorkflowRevision(parsed.workflowRevisionId), "Workflow revision");
    }
    if (automation === undefined && parsed.workflowRevisionId === undefined) {
      throw new AuditDomainError(
        "An audit run requires a legacy workflow revision or an automation runtime mapping",
        "INVALID_AUDIT_RUN_REFERENCE",
        409
      );
    }
    if (parsed.sourceEventId !== undefined) {
      const event = this.database.prepare("SELECT repository_id FROM repository_events WHERE id = ?").get(parsed.sourceEventId) as { repository_id: string } | undefined;
      if (event === undefined || event.repository_id !== parsed.repositoryId) {
        throw new AuditDomainError("Source event does not belong to repository", "INVALID_AUDIT_RUN_REFERENCE", 409);
      }
    }
    let configuredExecutionProfile = parsed.executionProfile;
    if (automation !== undefined) {
      if (
        automation.repositoryId !== parsed.repositoryId
        || automation.workflowRevisionId !== parsed.workflowRevisionId
        || automation.policyRevisionId !== parsed.policyRevisionId
      ) {
        throw new AuditDomainError("Automation and run revisions do not match", "INVALID_AUDIT_RUN_REFERENCE", 409);
      }
      if (automation.runtimeDefinitionId !== undefined) this.validateRuntimeDefinition(automation.runtimeDefinitionId);
      configuredExecutionProfile = automation.executionProfile;
    }
    const executionProfile = repository.trustLevel === "trusted_local"
      ? configuredExecutionProfile
      : "static_readonly";

    const run = auditRunSchema.parse({
      ...parsed,
      executionProfile,
      id: `auditrun_${randomUUID()}`,
      status: "created",
      publicationStatus: "skipped",
      createdAt: now()
    });
    try {
      this.database.prepare(`
        INSERT INTO audit_runs (
          id, repository_id, source, source_event_id, scheduled_for, automation_id,
          workflow_revision_id, policy_revision_id, execution_profile,
          base_revision, head_revision, status, publication_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.repositoryId,
        run.source,
        run.sourceEventId ?? null,
        run.scheduledFor ?? null,
        run.automationId ?? null,
        run.workflowRevisionId ?? null,
        run.policyRevisionId,
        run.executionProfile,
        run.baseRevision ?? null,
        run.headRevision ?? null,
        run.status,
        run.publicationStatus,
        run.createdAt
      );
    } catch (error) {
      if (
        isUniqueConstraint(error)
        && error instanceof Error
        && /audit_runs\.automation_id/i.test(error.message)
      ) {
        throw new AuditDomainError(
          "Automation already has an active audit run",
          "AUDIT_RUN_ALREADY_ACTIVE",
          409
        );
      }
      throw error;
    }
    return run;
  }

  listAuditRunPlanningReceipts(automationId?: string): AuditRunPlanningReceipt[] {
    const rows = (automationId === undefined
      ? this.database.prepare(`
          SELECT * FROM audit_run_planning_receipts ORDER BY created_at DESC, id
        `).all()
      : this.database.prepare(`
          SELECT * FROM audit_run_planning_receipts
          WHERE automation_id = ?
          ORDER BY created_at DESC, id
        `).all(automationId)) as any[];
    return rows.map(row => this.auditRunPlanningReceiptFromRow(row));
  }

  /**
   * Atomically records a trigger decision and, only when no active run exists,
   * creates a durable draft. BEGIN IMMEDIATE serializes the read/coalesce/write
   * decision across SQLite connections; receipt uniqueness makes event replay
   * idempotent across process restarts.
   */
  planAuditRunDraft(input: PlanAuditRunDraftRequest): AuditRunPlanningResult {
    const parsed = planAuditRunDraftRequestSchema.parse(input);
    const transaction = this.database.transaction((): AuditRunPlanningResult => {
      const replayed = this.findAuditRunPlanningReceipt(parsed);
      if (replayed !== undefined) return this.auditRunPlanningResult(replayed, "deduplicated");

      const repository = assertFound(this.getRepository(parsed.repositoryId), "Repository");
      const automation = assertFound(this.getAutomation(parsed.automationId), "Automation");
      assertFound(this.getPolicyRevision(parsed.policyRevisionId), "Policy revision");
      const workflow = parsed.workflowRevisionId === undefined
        ? undefined
        : assertFound(this.getWorkflowRevision(parsed.workflowRevisionId), "Workflow revision");
      const expectedDigest = workflow?.digest
        ?? (automation.runtimeDefinitionId === undefined ? undefined : runtimeWorkflowDigest(automation.runtimeDefinitionId));
      if (
        automation.repositoryId !== parsed.repositoryId
        || automation.workflowRevisionId !== parsed.workflowRevisionId
        || automation.policyRevisionId !== parsed.policyRevisionId
        || automation.executionProfile !== parsed.executionProfile
        || expectedDigest !== parsed.workflowDigest
        || (workflow === undefined && automation.runtimeDefinitionId === undefined)
      ) {
        throw new AuditDomainError(
          "Automation and planning revisions do not match",
          "INVALID_AUDIT_RUN_REFERENCE",
          409
        );
      }

      if (parsed.source === "repository_event") {
        const event = assertFound(this.getRepositoryEvent(parsed.sourceEventId!), "Repository event");
        if (event.repositoryId !== parsed.repositoryId) {
          throw new AuditDomainError(
            "Source event does not belong to repository",
            "INVALID_AUDIT_RUN_REFERENCE",
            409
          );
        }
        if (
          !automation.enabled
          || automation.trigger.type !== "repository_event"
          || !automation.trigger.eventTypes.includes(event.type)
        ) {
          throw new AuditDomainError(
            "Automation does not match this repository event",
            "AUTOMATION_TRIGGER_NOT_MATCHED",
            409
          );
        }
      } else if (parsed.source === "schedule") {
        if (!automation.enabled || automation.trigger.type !== "schedule") {
          throw new AuditDomainError(
            "Automation is not an enabled schedule trigger",
            "AUTOMATION_TRIGGER_NOT_MATCHED",
            409
          );
        }
        const scheduleState = this.getAutomationScheduleState(automation.id);
        if (
          scheduleState === undefined
          || scheduleState.status !== "scheduled"
          || scheduleState.nextScheduledAt !== parsed.scheduledFor
        ) {
          throw new AuditDomainError(
            "Schedule window is no longer open",
            "AUTOMATION_SCHEDULE_WINDOW_CLOSED",
            409
          );
        }
      }

      const activeRun = this.activeAuditRunForAutomation(parsed.automationId);
      if (activeRun !== undefined) {
        const receipt = this.insertAuditRunPlanningReceipt(parsed, activeRun.id, "coalesced");
        return this.auditRunPlanningResult(receipt, "coalesced");
      }

      const executionProfile = repository.trustLevel === "trusted_local"
        ? automation.executionProfile
        : "static_readonly";
      const auditRun = this.createAuditRunDraft({
        repositoryId: parsed.repositoryId,
        source: parsed.source,
        automationId: parsed.automationId,
        workflowRevisionId: parsed.workflowRevisionId,
        policyRevisionId: parsed.policyRevisionId,
        executionProfile,
        sourceEventId: parsed.sourceEventId,
        scheduledFor: parsed.scheduledFor,
        baseRevision: parsed.baseRevision,
        headRevision: parsed.headRevision
      });
      const receipt = this.insertAuditRunPlanningReceipt(parsed, auditRun.id, "created");
      return this.auditRunPlanningResult(receipt, "created");
    });

    try {
      return transaction.immediate();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const replayed = this.findAuditRunPlanningReceipt(parsed);
        if (replayed !== undefined) return this.auditRunPlanningResult(replayed, "deduplicated");
      }
      throw error;
    }
  }

  getAutomationScheduleState(automationId: string): AutomationScheduleState | undefined {
    const row = this.database.prepare(`
      SELECT * FROM automation_schedule_states WHERE automation_id = ?
    `).get(automationId) as any;
    return row === undefined ? undefined : this.automationScheduleStateFromRow(row);
  }

  ensureAutomationScheduleState(input: AutomationScheduleState): AutomationScheduleState {
    const desired = automationScheduleStateSchema.parse(sanitizeStructuredData(input));
    const automation = assertFound(this.getAutomation(desired.automationId), "Automation");
    if (automation.trigger.type !== "schedule") {
      throw new AuditDomainError("Automation is not schedule-triggered", "AUTOMATION_TRIGGER_NOT_MATCHED", 409);
    }
    return this.database.transaction(() => {
      const existing = this.getAutomationScheduleState(desired.automationId);
      if (
        existing !== undefined
        && existing.cron === desired.cron
        && existing.timezone === desired.timezone
        && existing.status === desired.status
      ) return existing;

      this.database.prepare(`
        INSERT INTO automation_schedule_states (
          automation_id, cron, timezone, status, next_scheduled_at,
          last_scheduled_for, last_outcome, last_planning_receipt_id,
          last_audit_run_id, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(automation_id) DO UPDATE SET
          cron = excluded.cron,
          timezone = excluded.timezone,
          status = excluded.status,
          next_scheduled_at = excluded.next_scheduled_at,
          last_scheduled_for = excluded.last_scheduled_for,
          last_outcome = excluded.last_outcome,
          last_planning_receipt_id = excluded.last_planning_receipt_id,
          last_audit_run_id = excluded.last_audit_run_id,
          error = excluded.error,
          updated_at = excluded.updated_at
      `).run(
        desired.automationId,
        desired.cron,
        desired.timezone,
        desired.status,
        desired.nextScheduledAt ?? null,
        desired.lastScheduledFor ?? null,
        desired.lastOutcome ?? null,
        desired.lastPlanningReceiptId ?? null,
        desired.lastAuditRunId ?? null,
        desired.error ?? null,
        desired.updatedAt
      );
      return assertFound(this.getAutomationScheduleState(desired.automationId), "Automation schedule state");
    }).immediate();
  }

  listAutomationScheduleWindows(automationId: string): AutomationScheduleWindow[] {
    assertFound(this.getAutomation(automationId), "Automation");
    const rows = this.database.prepare(`
      SELECT * FROM automation_schedule_windows
      WHERE automation_id = ?
      ORDER BY scheduled_for DESC, id
    `).all(automationId) as any[];
    return rows.map(row => this.automationScheduleWindowFromRow(row));
  }

  completeAutomationScheduleWindow(
    input: CompleteAutomationScheduleWindowInput
  ): AutomationScheduleWindow | undefined {
    const requestedWindow = automationScheduleWindowSchema.parse(input.window);
    const transaction = this.database.transaction((): AutomationScheduleWindow | undefined => {
      const existingRow = this.database.prepare(`
        SELECT * FROM automation_schedule_windows
        WHERE automation_id = ? AND scheduled_for = ?
      `).get(requestedWindow.automationId, requestedWindow.scheduledFor) as any;
      if (existingRow !== undefined) return this.automationScheduleWindowFromRow(existingRow);

      const current = this.getAutomationScheduleState(requestedWindow.automationId);
      if (
        current === undefined
        || current.status !== "scheduled"
        || current.nextScheduledAt !== input.expectedScheduledFor
        || requestedWindow.scheduledFor !== input.expectedScheduledFor
      ) return undefined;

      // Planning and window completion are separate durable steps so a crash
      // can be recovered. If another scheduler already persisted planning for
      // this tuple, that receipt wins over a competing late "skip" decision.
      const scheduleReceiptRow = this.database.prepare(`
        SELECT * FROM audit_run_planning_receipts
        WHERE automation_id = ? AND scheduled_for = ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(requestedWindow.automationId, requestedWindow.scheduledFor) as any;
      const scheduleReceipt = scheduleReceiptRow === undefined
        ? undefined
        : this.auditRunPlanningReceiptFromRow(scheduleReceiptRow);
      let window = requestedWindow;
      if (requestedWindow.outcome === "skipped" && scheduleReceipt !== undefined) {
        window = automationScheduleWindowSchema.parse({
          ...requestedWindow,
          outcome: scheduleReceipt.disposition,
          planningReceiptId: scheduleReceipt.id,
          auditRunId: scheduleReceipt.auditRunId,
          reason: undefined
        });
      } else if (requestedWindow.outcome !== "skipped") {
        if (
          scheduleReceipt === undefined
          || scheduleReceipt.id !== requestedWindow.planningReceiptId
          || scheduleReceipt.auditRunId !== requestedWindow.auditRunId
        ) {
          throw new AuditDomainError(
            "Schedule window does not match its durable planning receipt",
            "AUTOMATION_SCHEDULE_WINDOW_CONFLICT",
            409
          );
        }
      }

      const nextState = automationScheduleStateSchema.parse({
        automationId: window.automationId,
        cron: current.cron,
        timezone: current.timezone,
        status: "scheduled",
        nextScheduledAt: input.nextScheduledAt,
        lastScheduledFor: window.scheduledFor,
        lastOutcome: window.outcome,
        lastPlanningReceiptId: window.planningReceiptId,
        lastAuditRunId: window.auditRunId,
        updatedAt: window.recordedAt
      });

      this.database.prepare(`
        INSERT INTO automation_schedule_windows (
          id, automation_id, scheduled_for, outcome, planning_receipt_id,
          audit_run_id, reason, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        window.id,
        window.automationId,
        window.scheduledFor,
        window.outcome,
        window.planningReceiptId ?? null,
        window.auditRunId ?? null,
        window.reason ?? null,
        window.recordedAt
      );
      this.database.prepare(`
        UPDATE automation_schedule_states SET
          status = ?, next_scheduled_at = ?, last_scheduled_for = ?,
          last_outcome = ?, last_planning_receipt_id = ?, last_audit_run_id = ?,
          error = NULL, updated_at = ?
        WHERE automation_id = ?
      `).run(
        nextState.status,
        nextState.nextScheduledAt,
        nextState.lastScheduledFor,
        nextState.lastOutcome,
        nextState.lastPlanningReceiptId ?? null,
        nextState.lastAuditRunId ?? null,
        nextState.updatedAt,
        nextState.automationId
      );
      return window;
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const existingRow = this.database.prepare(`
          SELECT * FROM automation_schedule_windows
          WHERE automation_id = ? AND scheduled_for = ?
        `).get(requestedWindow.automationId, requestedWindow.scheduledFor) as any;
        if (existingRow !== undefined) return this.automationScheduleWindowFromRow(existingRow);
      }
      throw error;
    }
  }

  markRunQueued(runId: string, options: MarkAuditRunTransitionOptions = {}): AuditRun {
    return this.transitionAuditRun(runId, ["created"], "queued", "run_queued", options);
  }

  markRunRunning(runId: string, options: MarkAuditRunTransitionOptions = {}): AuditRun {
    return this.transitionAuditRun(runId, ["queued"], "running", "run_running", options);
  }

  markRunTerminal(
    runId: string,
    status: Extract<AuditRun["status"], "succeeded" | "failed">,
    options: MarkAuditRunTransitionOptions = {}
  ): AuditRun {
    const eventType: AuditRunEventType = status === "succeeded" ? "run_succeeded" : "run_failed";
    return this.transitionAuditRun(runId, ["running"], status, eventType, options);
  }

  markRunFailedFromQueued(runId: string, options: MarkAuditRunTransitionOptions = {}): AuditRun {
    return this.transitionAuditRun(runId, ["queued"], "failed", "run_failed", options);
  }

  listRunEvents(runId: string): AuditRunEvent[] {
    assertFound(this.getAuditRun(runId), "Audit run");
    const rows = this.database.prepare(`
      SELECT * FROM audit_run_events WHERE audit_run_id = ? ORDER BY seq ASC
    `).all(runId) as any[];
    return rows.map(row => this.auditRunEventFromRow(row));
  }

  /**
   * One-way lifecycle step: created → queued → running → terminal. Each legal
   * transition atomically updates the run row and appends exactly one
   * audit_run_events entry; the workflow-runtime run link is immutable once
   * written and a conflicting link aborts the whole transition.
   */
  private transitionAuditRun(
    runId: string,
    expectedStatuses: readonly AuditRun["status"][],
    nextStatus: AuditRun["status"],
    eventType: AuditRunEventType,
    options: MarkAuditRunTransitionOptions
  ): AuditRun {
    const transition = this.database.transaction((): AuditRun => {
      const currentRow = assertFound(this.getAuditRunRawRow(runId), "Audit run");
      if (!expectedStatuses.includes(currentRow.status)) {
        throw new AuditDomainError(
          `Audit run in '${currentRow.status}' cannot transition to '${nextStatus}'`,
          "AUDIT_RUN_INVALID_TRANSITION",
          409
        );
      }
      const previousLink = currentRow.workflow_runtime_run_id ?? undefined;
      const requestedLink = options.workflowRuntimeRunId;
      if (
        previousLink !== undefined
        && requestedLink !== undefined
        && previousLink !== requestedLink
      ) {
        throw new AuditDomainError(
          `Audit run is already linked to workflow runtime run '${previousLink}'`,
          "AUDIT_RUN_RUNTIME_LINK_CONFLICT",
          409
        );
      }
      const resolvedLink = previousLink ?? requestedLink;

      const timestampValue = now();
      const startedAt = nextStatus === "running"
        ? timestampValue
        : currentRow.started_at ?? null;
      const finishedAt = nextStatus === "succeeded" || nextStatus === "failed"
        ? timestampValue
        : currentRow.finished_at ?? null;
      const executionError = nextStatus === "failed"
        ? options.executionError === undefined
          ? currentRow.execution_error ?? null
          : sanitizeExecutionError(options.executionError)
        : currentRow.execution_error ?? null;

      this.database.prepare(`
        UPDATE audit_runs SET
          status = ?, workflow_runtime_run_id = ?, execution_error = ?,
          started_at = ?, finished_at = ?
        WHERE id = ?
      `).run(
        nextStatus,
        resolvedLink ?? null,
        executionError,
        startedAt,
        finishedAt,
        runId
      );

      this.appendAuditRunEvent(runId, eventType, {
        fromStatus: currentRow.status,
        status: nextStatus,
        ...(resolvedLink === undefined ? {} : { workflowRuntimeRunId: resolvedLink }),
        ...(executionError === null ? {} : { executionError })
      });
      return assertFound(this.getAuditRun(runId), "Audit run");
    });
    return transition.immediate();
  }

  cancelAuditRun(id: string): AuditRun {
    const cancel = this.database.transaction((): AuditRun => {
      // The read and guarded write share the same immediate transaction. The
      // row used for fromStatus is therefore the row that was actually won.
      const current = assertFound(this.getAuditRunRawRow(id), "Audit run");
      if (current.status !== "created" && current.status !== "queued") {
        throw new AuditDomainError(`Audit run in '${current.status}' cannot be cancelled`, "AUDIT_RUN_NOT_CANCELLABLE", 409);
      }
      const finishedAt = now();
      const result = this.database.prepare(`
        UPDATE audit_runs SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND status IN ('created', 'queued')
      `).run(finishedAt, id);
      if (result.changes !== 1) {
        const latest = assertFound(this.getAuditRunRawRow(id), "Audit run");
        throw new AuditDomainError(`Audit run in '${latest.status}' cannot be cancelled`, "AUDIT_RUN_NOT_CANCELLABLE", 409);
      }
      this.appendAuditRunEvent(id, "run_cancelled", {
        fromStatus: current.status,
        status: "cancelled"
      });
      return assertFound(this.getAuditRun(id), "Audit run");
    });
    return cancel.immediate();
  }

  listRunStepArtifacts(auditRunId: string): RunStepArtifact[] {
    assertFound(this.getAuditRun(auditRunId), "Audit run");
    const rows = this.database.prepare(`
      SELECT * FROM run_step_artifacts WHERE audit_run_id = ? ORDER BY started_at, step_id
    `).all(auditRunId) as any[];
    return rows.map(row => this.runStepArtifactFromRow(row));
  }

  saveRunStepArtifact(input: RunStepArtifact): RunStepArtifact {
    const artifact = runStepArtifactSchema.parse(sanitizeStructuredData(input));
    assertFound(this.getAuditRun(artifact.auditRunId), "Audit run");
    this.database.prepare(`
      INSERT INTO run_step_artifacts (
        id, audit_run_id, step_id, uses, status, required, input_digest,
        tool_version, ruleset_digest, started_at, finished_at, duration_ms,
        evidence_json, log_summary, skip_reason, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(audit_run_id, step_id) DO UPDATE SET
        status = excluded.status,
        tool_version = excluded.tool_version,
        ruleset_digest = excluded.ruleset_digest,
        finished_at = excluded.finished_at,
        duration_ms = excluded.duration_ms,
        evidence_json = excluded.evidence_json,
        log_summary = excluded.log_summary,
        skip_reason = excluded.skip_reason,
        error = excluded.error
    `).run(
      artifact.id,
      artifact.auditRunId,
      artifact.stepId,
      artifact.uses,
      artifact.status,
      artifact.required ? 1 : 0,
      artifact.inputDigest,
      artifact.toolVersion ?? null,
      artifact.rulesetDigest ?? null,
      artifact.startedAt,
      artifact.finishedAt ?? null,
      artifact.durationMs ?? null,
      artifact.evidence === undefined ? null : JSON.stringify(artifact.evidence),
      artifact.logSummary ?? null,
      artifact.skipReason ?? null,
      artifact.error ?? null
    );
    return artifact;
  }

  listIssues(repositoryId?: string, state?: AuditIssue["state"]): AuditIssue[] {
    let rows: any[];
    if (repositoryId !== undefined && state !== undefined) {
      rows = this.database.prepare("SELECT * FROM audit_issues WHERE repository_id = ? AND state = ? ORDER BY last_seen_at DESC, id ASC").all(repositoryId, state) as any[];
    } else if (repositoryId !== undefined) {
      rows = this.database.prepare("SELECT * FROM audit_issues WHERE repository_id = ? ORDER BY last_seen_at DESC, id ASC").all(repositoryId) as any[];
    } else if (state !== undefined) {
      rows = this.database.prepare("SELECT * FROM audit_issues WHERE state = ? ORDER BY last_seen_at DESC, id ASC").all(state) as any[];
    } else {
      rows = this.database.prepare("SELECT * FROM audit_issues ORDER BY last_seen_at DESC, id ASC").all() as any[];
    }
    return rows.map(row => this.issueFromRow(row));
  }

  getIssue(id: string): AuditIssue | undefined {
    const row = this.database.prepare("SELECT * FROM audit_issues WHERE id = ?").get(id) as any;
    return row === undefined ? undefined : this.issueFromRow(row);
  }

  createIssue(input: CreateAuditIssueRequest): AuditIssue {
    const validated = createAuditIssueRequestSchema.parse(input);
    const parsed = createAuditIssueRequestSchema.parse({
      ...validated,
      location: validated.location === undefined ? undefined : sanitizeStructuredData(validated.location),
      evidenceSummary: sanitizeExecutionError(validated.evidenceSummary),
      tags: sanitizeStructuredData(validated.tags),
    });
    assertFound(this.getRepository(parsed.repositoryId), "Repository");
    const firstRun = assertFound(this.getAuditRun(parsed.firstSeenRunId), "First-seen audit run");
    const lastRun = assertFound(this.getAuditRun(parsed.lastSeenRunId), "Last-seen audit run");
    if (firstRun.repositoryId !== parsed.repositoryId || lastRun.repositoryId !== parsed.repositoryId) {
      throw new AuditDomainError("Issue runs do not belong to repository", "INVALID_ISSUE_REFERENCE", 409);
    }
    const observedAt = now();
    const issue = auditIssueSchema.parse({
      ...parsed,
      id: `issue_${randomUUID()}`,
      state: "open",
      firstSeenAt: observedAt,
      lastSeenAt: observedAt
    });
    try {
      this.database.prepare(`
        INSERT INTO audit_issues (
          id, repository_id, fingerprint, rule_id, title, severity, confidence,
          state, location_json, evidence_summary, first_seen_run_id,
          last_seen_run_id, first_seen_at, last_seen_at, resolved_at,
          state_reason, tags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        issue.id,
        issue.repositoryId,
        issue.fingerprint,
        issue.ruleId,
        issue.title,
        issue.severity,
        issue.confidence,
        issue.state,
        issue.location === undefined ? null : JSON.stringify(issue.location),
        issue.evidenceSummary,
        issue.firstSeenRunId,
        issue.lastSeenRunId,
        issue.firstSeenAt,
        issue.lastSeenAt,
        null,
        null,
        JSON.stringify(issue.tags)
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AuditDomainError("Issue fingerprint already exists for repository", "ISSUE_ALREADY_EXISTS", 409);
      }
      throw error;
    }
    return issue;
  }

  applyIssueAction(id: string, action: AuditIssueAction, reason?: string): AuditIssue {
    assertFound(this.getIssue(id), "Issue");
    if (["accept_risk", "mark_false_positive", "suppress"].includes(action) && reason === undefined) {
      throw new AuditDomainError("This issue triage action requires a reason", "ISSUE_REASON_REQUIRED", 400);
    }
    // Sanitize before the UPDATE so the raw reason never enters SQLite. Keep
    // undefined distinct from null: omission remains an omitted DTO field,
    // while a stored SQL NULL is also projected as undefined.
    const safeReason = reason === undefined ? undefined : sanitizeExecutionError(reason);
    const state: AuditIssue["state"] = action === "review" || action === "acknowledge"
      ? "reviewing"
      : action === "accept_risk" || action === "suppress"
        ? "accepted_risk"
        : action === "mark_false_positive" ? "false_positive" : action === "resolve" ? "resolved" : "open";
    const resolvedAt = state === "resolved" ? now() : null;
    this.database.prepare(`
      UPDATE audit_issues SET state = ?, state_reason = ?, resolved_at = ? WHERE id = ?
    `).run(state, safeReason ?? null, resolvedAt, id);
    return assertFound(this.getIssue(id), "Issue");
  }

  saveFindingOccurrence(input: FindingOccurrence): FindingOccurrence {
    const validated = findingOccurrenceSchema.parse(input);
    const occurrence = findingOccurrenceSchema.parse({
      ...validated,
      location: validated.location === undefined ? undefined : sanitizeStructuredData(validated.location),
      evidenceSummary: sanitizeExecutionError(validated.evidenceSummary),
    });
    assertFound(this.getIssue(occurrence.issueId), "Issue");
    assertFound(this.getAuditRun(occurrence.auditRunId), "Audit run");
    this.database.prepare(`
      INSERT INTO finding_occurrences (
        id, issue_id, audit_run_id, artifact_id, kind, severity, confidence,
        location_json, evidence_summary, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      occurrence.id,
      occurrence.issueId,
      occurrence.auditRunId,
      occurrence.artifactId ?? null,
      occurrence.kind,
      occurrence.severity,
      occurrence.confidence,
      occurrence.location === undefined ? null : JSON.stringify(occurrence.location),
      occurrence.evidenceSummary,
      occurrence.observedAt
    );
    return occurrence;
  }

  listEvolutionSnapshots(repositoryId: string): EvolutionSnapshot[] {
    assertFound(this.getRepository(repositoryId), "Repository");
    const rows = this.database.prepare(`
      SELECT snapshot_json FROM evolution_snapshots
      WHERE repository_id = ? ORDER BY captured_at DESC, id ASC
    `).all(repositoryId) as Array<{ snapshot_json: string }>;
    return rows.map(row => evolutionSnapshotSchema.parse(sanitizeStructuredData(parseJson(row.snapshot_json))));
  }

  saveEvolutionSnapshot(input: EvolutionSnapshot): EvolutionSnapshot {
    const validated = evolutionSnapshotSchema.parse(input);
    const snapshot = evolutionSnapshotSchema.parse(sanitizeStructuredData(validated));
    assertFound(this.getRepository(snapshot.repositoryId), "Repository");
    if (snapshot.auditRunId !== undefined) assertFound(this.getAuditRun(snapshot.auditRunId), "Audit run");
    this.database.prepare(`
      INSERT INTO evolution_snapshots (id, repository_id, audit_run_id, head_revision, captured_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, head_revision) DO UPDATE SET
        audit_run_id = excluded.audit_run_id,
        captured_at = excluded.captured_at,
        snapshot_json = excluded.snapshot_json
    `).run(snapshot.id, snapshot.repositoryId, snapshot.auditRunId ?? null, snapshot.headRevision, snapshot.capturedAt, JSON.stringify(snapshot));
    return snapshot;
  }

  getAuditReport(auditRunId: string): AuditReportV2 | undefined {
    const row = this.database.prepare("SELECT report_json FROM audit_reports_v2 WHERE audit_run_id = ?")
      .get(auditRunId) as { report_json: string } | undefined;
    return row === undefined ? undefined : auditReportV2Schema.parse(sanitizeStructuredData(parseJson(row.report_json)));
  }

  saveAuditReport(input: AuditReportV2): AuditReportV2 {
    const validated = auditReportV2Schema.parse(input);
    const report = auditReportV2Schema.parse(sanitizeStructuredData(validated));
    assertFound(this.getAuditRun(report.run.id), "Audit run");
    this.database.prepare(`
      INSERT INTO audit_reports_v2 (id, audit_run_id, report_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(audit_run_id) DO UPDATE SET report_json = excluded.report_json, created_at = excluded.created_at
    `).run(report.id, report.run.id, JSON.stringify(report), report.createdAt);
    return report;
  }

  /** Narrow positional projection for lifecycle guard checks. */
  private getAuditRunRawRow(id: string): {
    id: string;
    status: AuditRun["status"];
    workflow_runtime_run_id: string | null;
    execution_error: string | null;
    started_at: string | null;
    finished_at: string | null;
  } | undefined {
    return this.database.prepare(`
      SELECT id, status, workflow_runtime_run_id, execution_error, started_at, finished_at
      FROM audit_runs WHERE id = ?
    `).get(id) as {
      id: string;
      status: AuditRun["status"];
      workflow_runtime_run_id: string | null;
      execution_error: string | null;
      started_at: string | null;
      finished_at: string | null;
    } | undefined;
  }

  private appendAuditRunEvent(
    auditRunId: string,
    eventType: AuditRunEventType,
    payload: Record<string, unknown>
  ): void {
    const seqRow = this.database.prepare(`
      SELECT coalesce(max(seq), 0) + 1 AS seq FROM audit_run_events WHERE audit_run_id = ?
    `).get(auditRunId) as { seq: number };
    const event = auditRunEventSchema.parse({
      id: `runevt_${randomUUID()}`,
      auditRunId,
      seq: seqRow.seq,
      eventType,
      payload: sanitizeStructuredData(payload),
      createdAt: now()
    });
    this.database.prepare(`
      INSERT INTO audit_run_events (id, audit_run_id, event_type, seq, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.auditRunId,
      event.eventType,
      seqRow.seq,
      JSON.stringify(event.payload),
      event.createdAt
    );
  }

  private auditRunEventFromRow(row: any): AuditRunEvent {
    return auditRunEventSchema.parse({
      id: row.id,
      auditRunId: row.audit_run_id,
      seq: row.seq,
      eventType: row.event_type,
      payload: sanitizeStructuredData(parseJson(row.payload_json)),
      createdAt: row.created_at
    });
  }

  private findAuditRunPlanningReceipt(
    input: PlanAuditRunDraftRequest
  ): AuditRunPlanningReceipt | undefined {
    let row = this.database.prepare(`
      SELECT * FROM audit_run_planning_receipts WHERE planning_key = ?
    `).get(input.planningKey) as any;
    if (row === undefined && input.sourceEventId !== undefined) {
      row = this.database.prepare(`
        SELECT * FROM audit_run_planning_receipts
        WHERE source_event_id = ? AND automation_id = ? AND workflow_digest = ?
      `).get(input.sourceEventId, input.automationId, input.workflowDigest) as any;
    }
    if (row === undefined && input.scheduledFor !== undefined) {
      row = this.database.prepare(`
        SELECT * FROM audit_run_planning_receipts
        WHERE automation_id = ? AND workflow_digest = ? AND scheduled_for = ?
      `).get(input.automationId, input.workflowDigest, input.scheduledFor) as any;
    }
    if (row === undefined) return undefined;
    const receipt = this.auditRunPlanningReceiptFromRow(row);
    if (
      receipt.repositoryId !== input.repositoryId
      || receipt.automationId !== input.automationId
      || receipt.workflowDigest !== input.workflowDigest
      || receipt.source !== input.source
      || receipt.sourceEventId !== input.sourceEventId
      || receipt.scheduledFor !== input.scheduledFor
    ) {
      throw new AuditDomainError(
        "Audit-run planning key conflicts with a different trigger",
        "AUDIT_RUN_PLANNING_KEY_CONFLICT",
        409
      );
    }
    return receipt;
  }

  private activeAuditRunForAutomation(automationId: string): AuditRun | undefined {
    const row = this.database.prepare(`
      SELECT * FROM audit_runs
      WHERE automation_id = ? AND status IN ('created', 'queued', 'running')
      ORDER BY created_at DESC, id
      LIMIT 1
    `).get(automationId) as any;
    return row === undefined ? undefined : this.auditRunFromRow(row);
  }

  private insertAuditRunPlanningReceipt(
    input: PlanAuditRunDraftRequest,
    auditRunId: string,
    disposition: AuditRunPlanningReceipt["disposition"]
  ): AuditRunPlanningReceipt {
    const receipt = auditRunPlanningReceiptSchema.parse({
      id: `planning_receipt_${randomUUID()}`,
      planningKey: input.planningKey,
      repositoryId: input.repositoryId,
      automationId: input.automationId,
      workflowDigest: input.workflowDigest,
      source: input.source,
      sourceEventId: input.sourceEventId,
      scheduledFor: input.scheduledFor,
      auditRunId,
      disposition,
      createdAt: now()
    });
    this.database.prepare(`
      INSERT INTO audit_run_planning_receipts (
        id, planning_key, repository_id, automation_id, workflow_digest,
        source, source_event_id, scheduled_for, audit_run_id, disposition, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.planningKey,
      receipt.repositoryId,
      receipt.automationId,
      receipt.workflowDigest,
      receipt.source,
      receipt.sourceEventId ?? null,
      receipt.scheduledFor ?? null,
      receipt.auditRunId,
      receipt.disposition,
      receipt.createdAt
    );
    return receipt;
  }

  private auditRunPlanningResult(
    receipt: AuditRunPlanningReceipt,
    disposition: AuditRunPlanningResult["disposition"]
  ): AuditRunPlanningResult {
    const auditRun = assertFound(this.getAuditRun(receipt.auditRunId), "Audit run");
    const reason = disposition === "created"
      ? "new_draft"
      : disposition === "coalesced"
        ? "active_run"
        : "trigger_replay";
    // Availability is computed at the composition root (executor armed ×
    // automation mapped × repository local); absence keeps the honest
    // draft-only fallback.
    const availability = this.resolveExecutionAvailability?.({
      repositoryId: receipt.repositoryId,
      automationId: receipt.automationId
    }) ?? { available: false as const, reason: AUDIT_DRAFT_ONLY_EXECUTION_REASON };
    return auditRunPlanningResultSchema.parse({
      disposition,
      reason,
      receipt,
      auditRun,
      execution: availability.available
        ? { available: true }
        : { available: false, reason: availability.reason ?? AUDIT_DRAFT_ONLY_EXECUTION_REASON }
    });
  }

  private repositoryFromRow(row: any): Repository {
    return repositorySchema.parse({
      id: row.id,
      displayName: row.display_name,
      source: row.source,
      remoteFullName: row.remote_full_name ?? undefined,
      defaultBranch: row.default_branch ?? undefined,
      trustLevel: row.trust_level,
      monitoringEnabled: row.monitoring_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private repositoryEventFromRow(row: any): RepositoryEvent {
    return repositoryEventSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      type: row.type,
      source: row.source,
      dedupeKey: row.dedupe_key,
      occurredAt: row.occurred_at,
      baseRevision: row.base_revision ?? undefined,
      headRevision: row.head_revision ?? undefined,
      changedFiles: sanitizeStructuredData(parseJson(row.changed_files_json)),
      metadata: sanitizeStructuredData(parseJson(row.metadata_json))
    });
  }

  private repositoryPulseFromRow(row: any): RepositoryPulse {
    return repositoryPulseSchema.parse({
      pulseId: row.pulse_id,
      repositoryId: row.repository_id,
      state: row.state,
      observedAt: row.observed_at,
      dirtyFileCount: row.dirty_file_count,
      pendingEvents: row.pending_events,
      branch: row.branch ?? undefined,
      headRevision: row.head_revision ?? undefined,
      metrics: row.metrics_json === null ? undefined : sanitizeStructuredData(parseJson(row.metrics_json)),
      lastError: row.last_error ?? undefined
    });
  }

  private automationFromRow(row: any): Automation {
    return automationSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      name: row.name,
      trigger: parseJson(row.trigger_json),
      workflowRevisionId: row.workflow_revision_id ?? undefined,
      policyRevisionId: row.policy_revision_id,
      runtimeDefinitionId: row.runtime_definition_id ?? undefined,
      executionProfile: row.execution_profile,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private auditRunFromRow(row: any): AuditRun {
    return auditRunSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      source: row.source,
      sourceEventId: row.source_event_id ?? undefined,
      scheduledFor: row.scheduled_for ?? undefined,
      automationId: row.automation_id ?? undefined,
      workflowRevisionId: row.workflow_revision_id ?? undefined,
      policyRevisionId: row.policy_revision_id,
      executionProfile: row.execution_profile,
      baseRevision: row.base_revision ?? undefined,
      headRevision: row.head_revision ?? undefined,
      status: row.status,
      riskScore: row.risk_score ?? undefined,
      coverage: row.coverage ?? undefined,
      policyEvaluation: row.policy_evaluation_json === null ? undefined : sanitizeStructuredData(parseJson(row.policy_evaluation_json)),
      publicationStatus: row.publication_status,
      workflowRuntimeRunId: row.workflow_runtime_run_id ?? undefined,
      executionError: row.execution_error === null ? undefined : sanitizeExecutionError(row.execution_error),
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      error: row.error === null ? undefined : sanitizeExecutionError(row.error)
    });
  }

  private auditRunPlanningReceiptFromRow(row: any): AuditRunPlanningReceipt {
    return auditRunPlanningReceiptSchema.parse({
      id: row.id,
      planningKey: row.planning_key,
      repositoryId: row.repository_id,
      automationId: row.automation_id,
      workflowDigest: row.workflow_digest,
      source: row.source,
      sourceEventId: row.source_event_id ?? undefined,
      scheduledFor: row.scheduled_for ?? undefined,
      auditRunId: row.audit_run_id,
      disposition: row.disposition,
      createdAt: row.created_at
    });
  }

  private automationScheduleStateFromRow(row: any): AutomationScheduleState {
    return automationScheduleStateSchema.parse({
      automationId: row.automation_id,
      cron: row.cron,
      timezone: row.timezone,
      status: row.status,
      nextScheduledAt: row.next_scheduled_at ?? undefined,
      lastScheduledFor: row.last_scheduled_for ?? undefined,
      lastOutcome: row.last_outcome ?? undefined,
      lastPlanningReceiptId: row.last_planning_receipt_id ?? undefined,
      lastAuditRunId: row.last_audit_run_id ?? undefined,
      error: row.error === null ? undefined : sanitizeExecutionError(row.error),
      updatedAt: row.updated_at
    });
  }

  private automationScheduleWindowFromRow(row: any): AutomationScheduleWindow {
    return automationScheduleWindowSchema.parse({
      id: row.id,
      automationId: row.automation_id,
      scheduledFor: row.scheduled_for,
      outcome: row.outcome,
      planningReceiptId: row.planning_receipt_id ?? undefined,
      auditRunId: row.audit_run_id ?? undefined,
      reason: row.reason ?? undefined,
      recordedAt: row.recorded_at
    });
  }

  private runStepArtifactFromRow(row: any): RunStepArtifact {
    return runStepArtifactSchema.parse({
      id: row.id,
      auditRunId: row.audit_run_id,
      stepId: row.step_id,
      uses: row.uses,
      status: row.status,
      required: row.required === 1,
      inputDigest: row.input_digest,
      toolVersion: row.tool_version ?? undefined,
      rulesetDigest: row.ruleset_digest ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      evidence: row.evidence_json === null ? undefined : sanitizeStructuredData(parseJson(row.evidence_json)),
      logSummary: row.log_summary === null ? undefined : sanitizeExecutionError(row.log_summary),
      skipReason: row.skip_reason === null ? undefined : sanitizeExecutionError(row.skip_reason),
      error: row.error === null ? undefined : sanitizeExecutionError(row.error)
    });
  }

  private issueFromRow(row: any): AuditIssue {
    return auditIssueSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      fingerprint: row.fingerprint,
      ruleId: row.rule_id,
      title: row.title,
      severity: row.severity,
      confidence: row.confidence,
      state: row.state,
      location: row.location_json === null ? undefined : sanitizeStructuredData(parseJson(row.location_json)),
      evidenceSummary: sanitizeExecutionError(row.evidence_summary),
      firstSeenRunId: row.first_seen_run_id,
      lastSeenRunId: row.last_seen_run_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at ?? undefined,
      stateReason: row.state_reason === null || row.state_reason === undefined
        ? undefined
        : sanitizeExecutionError(String(row.state_reason)),
      tags: parseJson(row.tags_json)
    });
  }
}
