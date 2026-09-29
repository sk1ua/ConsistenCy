/**
 * Completion notices — the terminal one-shot summary pushed to a supervisor
 * channel (H15).
 *
 * Contract:
 *   - Terminal only: one notice per run terminal transition, keyed by the
 *     idempotency key `completion:<runId>:<attempt>`. A duplicate terminal
 *     trigger (e.g. the host's defensive fallback path firing after the
 *     transactional path already recorded the terminal state) produces the
 *     SAME key, so the outbox's UNIQUE constraint deduplicates it — repeated
 *     triggers never duplicate the notification.
 *   - Redaction-before-persistence: the error string passes the shared
 *     sanitizers (security/redact) and the assembled notice passes
 *     sanitizeStructuredData BEFORE it is handed to the outbox store, so no
 *     secret, bearer token, credential-shaped string, absolute local path, or
 *     raw private prompt content can reach the payload. The notice is an
 *     allowlist: only the fields of completionNoticeSchema exist — anything
 *     else in the terminal input is dropped, never copied through.
 *   - Evidence by REFERENCE only: `{ id, path, fingerprint }` per record
 *     (mirroring the schema package's fingerprint-only evidence summaries);
 *     file contents, prompts, and payloads are never included.
 *   - Attempt semantics: the workflow runtime runs each step exactly once
 *     (executor attemptNumber is always 1) and never retries a run
 *     in-process, so a terminal workflow run reports attempt 1. The field
 *     exists so a future retrying runtime can report its real attempt without
 *     a schema change.
 *   - Remaining budget: reported only when the runtime actually tracks one
 *     (same shape as the schema package's agentBudgetSnapshot). The current
 *     workflow runtime issues capabilities without budgets, so the field is
 *     legitimately absent for its notices — it is never invented.
 * Boundary: trusted host side. This module is DATA — it grants no capability
 * and authorizes nothing.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  isTerminalExecutionLifecycleState,
  projectRunTerminal,
  terminalReasonSchema,
  tryToExecutionLifecycleState,
  type ExecutionLifecycleState,
  type TerminalReason,
} from "@consistency/schema";
import { sanitizeExecutionError, sanitizePublicError, sanitizeStructuredData } from "../security/redact";

const nonEmpty = z.string().trim().min(1);

/** Evidence by reference only — id/path/fingerprint, never content. */
export const completionEvidenceRefSchema = z.object({
  id: nonEmpty,
  path: z.string(),
  fingerprint: z.string(),
}).strict();

/**
 * Remaining budget at terminal time. Key names deliberately avoid the token
 * `tokenBudget` spelling used by the kernel's agent budget snapshot: the
 * shared structured sanitizer redacts any "token"-keyed value (sensitive-key
 * heuristic), so the notice reports remaining amounts under "remaining*"
 * names instead — same quantities, sanitizer-compatible keys.
 */
export const completionRemainingBudgetSchema = z.object({
  remainingTokens: z.number().int().nonnegative().optional(),
  remainingCostUsdMicros: z.string().optional(),
  remainingWallTimeMs: z.number().int().nonnegative().optional(),
}).strict();

/** Maximum evidence references carried by one notice; the total is preserved
 * in evidenceCount so a supervisor can tell when the list was capped. */
export const MAX_NOTICE_EVIDENCE_REFS = 50;

export const completionNoticeSchema = z.object({
  idempotencyKey: nonEmpty,
  runId: nonEmpty,
  attempt: z.number().int().min(1),
  result: z.enum(["succeeded", "failed"]),
  terminalReason: terminalReasonSchema,
  finishedAt: z.string().datetime(),
  definitionId: z.string().optional(),
  repository: z.string().optional(),
  headSha: z.string().optional(),
  evidence: z.array(completionEvidenceRefSchema).max(MAX_NOTICE_EVIDENCE_REFS).default([]),
  evidenceCount: z.number().int().nonnegative().default(0),
  findingsCount: z.number().int().nonnegative().default(0),
  /** Sanitized terminal error — never a raw provider/persistence message. */
  error: z.string().optional(),
  remainingBudget: completionRemainingBudgetSchema.optional(),
  createdAt: z.string().datetime(),
}).strict();

export type CompletionEvidenceRef = z.infer<typeof completionEvidenceRefSchema>;
export type CompletionRemainingBudget = z.infer<typeof completionRemainingBudgetSchema>;
export type CompletionNotice = z.infer<typeof completionNoticeSchema>;

/**
 * The terminal input the WorkflowRuntimeHost hands over when a run reaches
 * `succeeded`/`failed`. Structural on purpose: the host owns that record's
 * canonical type; this module only reads the fields it may publish.
 */
export type CompletionTerminalInput = {
  readonly runId: string;
  readonly status: "succeeded" | "failed";
  /**
   * Wave 3 / R3 (task-10): the AUTHORITATIVE refined terminal facts the run row
   * and its terminal ledger event were written with (optional, backward
   * compatible). When present they decide the notice's `result` +
   * `terminalReason` — a cancelled / interrupted / degraded / budget-exhausted
   * run is never reported as `fatal_error`.
   */
  readonly lifecycleState?: ExecutionLifecycleState;
  readonly terminalReason?: TerminalReason;
  readonly finishedAt: string;
  readonly evidence: unknown[];
  readonly miniReport?: unknown;
  readonly error?: string;
  /** Remaining budget at terminal time — populated ONLY by a runtime that
   * actually tracks one. The workflow runtime issues capabilities without
   * budgets and therefore never passes this field. */
  readonly remainingBudget?: CompletionRemainingBudget;
};

/** Deterministic idempotency identity of a terminal notice. */
export function completionIdempotencyKey(runId: string, attempt: number): string {
  return `completion:${runId}:${attempt}`;
}

/**
 * The notice's terminal facts come from the SAME mapping the run row and the
 * terminal ledger event were written with (`projectRunTerminal`) — there is
 * deliberately NO second switch here, so a notice can never disagree with the
 * durable run row.
 *
 * Legacy compatibility: a caller that has no refined facts (pre-R3 rows, older
 * integrations) falls back to the coarse `status`, which the shared mapping
 * turns into `completed` / `fatal_error` exactly as before.
 */
function terminalFactsOf(input: CompletionTerminalInput): {
  readonly result: "succeeded" | "failed";
  readonly terminalReason: TerminalReason;
} {
  const refined = input.lifecycleState !== undefined && isTerminalExecutionLifecycleState(input.lifecycleState)
    ? input.lifecycleState
    : undefined;
  const lifecycleState = refined ?? tryToExecutionLifecycleState(input.status);
  if (lifecycleState === undefined) {
    // Unreachable for the declared status union; kept explicit so a future
    // status value fails loudly instead of being coerced.
    throw new Error(`cannot map status '${input.status}' to a terminal lifecycle state`);
  }
  const projection = projectRunTerminal({
    lifecycleState,
    ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
  });
  return { result: projection.status, terminalReason: projection.terminalReason };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Extract reference-only evidence fields from the run's evidence summaries. */
function evidenceRefsFrom(records: unknown[]): CompletionEvidenceRef[] {
  const refs: CompletionEvidenceRef[] = [];
  for (const record of records) {
    if (refs.length >= MAX_NOTICE_EVIDENCE_REFS) break;
    if (record === null || typeof record !== "object") continue;
    const candidate = record as Record<string, unknown>;
    const id = asString(candidate.id);
    if (id === undefined) continue;
    refs.push({
      id,
      path: typeof candidate.path === "string" ? sanitizePublicError(candidate.path) : "",
      fingerprint: typeof candidate.fingerprint === "string" ? candidate.fingerprint : "",
    });
  }
  return refs;
}

/**
 * Build the terminal notice from a run's terminal record. Every free-text
 * surface is sanitized here; the result is validated against the strict
 * notice schema (unknown fields are dropped, never transported).
 */
export function buildCompletionNotice(
  input: CompletionTerminalInput,
  options: { now?: string } = {},
): CompletionNotice {
  const attempt = 1; // workflow runs execute exactly once; see module contract
  const miniReport = (input.miniReport !== null && typeof input.miniReport === "object"
    ? input.miniReport as Record<string, unknown>
    : {}) as Record<string, unknown>;
  const error = input.error === undefined
    ? miniReport.error
    : input.error;
  // ONE mapping for the notice's result + reason (see terminalFactsOf): the
  // authoritative refined facts win, the coarse status is only the documented
  // legacy fallback.
  const terminalFacts = terminalFactsOf(input);
  const notice = completionNoticeSchema.parse({
    idempotencyKey: completionIdempotencyKey(input.runId, attempt),
    runId: input.runId,
    attempt,
    result: terminalFacts.result,
    terminalReason: terminalFacts.terminalReason,
    finishedAt: input.finishedAt,
    ...(asString(miniReport.definitionId) === undefined ? {} : { definitionId: asString(miniReport.definitionId) }),
    ...(asString(miniReport.repository) === undefined ? {} : { repository: asString(miniReport.repository) }),
    ...(asString(miniReport.headSha) === undefined ? {} : { headSha: asString(miniReport.headSha) }),
    evidence: evidenceRefsFrom(input.evidence),
    evidenceCount: asNonNegativeInt(miniReport.evidenceCount) ?? input.evidence.length,
    findingsCount: asNonNegativeInt(Array.isArray(miniReport.findings) ? miniReport.findings.length : undefined) ?? 0,
    ...(asString(error) === undefined ? {} : { error: sanitizeExecutionError(asString(error)!) }),
    ...(input.remainingBudget === undefined ? {} : { remainingBudget: input.remainingBudget }),
    createdAt: options.now ?? new Date().toISOString(),
  });
  // Defense in depth: even though the builder only emits allowlisted fields,
  // the assembled notice passes the shared structured sanitizer so no
  // credential-shaped string can reach the store (mirrors the event ledger's
  // redaction-before-persistence doctrine).
  return sanitizeStructuredData(notice) as CompletionNotice;
}

/** Internal identifier for an outbox row (distinct from the wire idempotency key). */
export function newCompletionOutboxId(): string {
  return "cmpl_" + randomUUID();
}
