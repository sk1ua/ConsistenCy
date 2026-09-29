import { describe, expect, it } from "vitest";
import {
  canTransitionExecutionLifecycle,
  createAttemptTrace,
  createStepTrace,
  defaultTerminalReasonForState,
  executionAttemptRecordSchema,
  executionLifecycleEventSchema,
  executionLifecycleStateSchema,
  executionRunRecordSchema,
  executionStepRecordSchema,
  executionTraceContextSchema,
  isTerminalExecutionLifecycleState,
  isTerminalReason,
  runExecutionTraceSchema,
  runRuntimeSnapshotSchema,
  runtimeRunSummarySchema,
  stepExecutionTraceSchema,
  attemptExecutionTraceSchema,
  terminalReasonSchema,
  toExecutionLifecycleState,
  tryToExecutionLifecycleState,
  type ExecutionLifecycleState,
  type TerminalReason,
} from "./runtime";
import { reviewJobSchema } from "./job";
import {
  workflowRuntimeRunSchema,
  workflowRuntimeRunSummarySchema,
  workflowRuntimeRunV2Schema,
} from "./workflow-runtime";

describe("Unified Execution Lifecycle & Provenance Protocol (@consistency/schema)", () => {
  describe("ExecutionLifecycleState", () => {
    const validStates: ExecutionLifecycleState[] = [
      "queued",
      "running",
      "awaiting_input",
      "succeeded",
      "failed",
      "cancelled",
      "degraded",
    ];

    it("parses all 7 valid execution lifecycle states", () => {
      for (const state of validStates) {
        expect(executionLifecycleStateSchema.parse(state)).toBe(state);
      }
    });

    it("rejects unknown or invalid lifecycle states", () => {
      expect(() => executionLifecycleStateSchema.parse("created")).toThrow();
      expect(() => executionLifecycleStateSchema.parse("pending")).toThrow();
      expect(() => executionLifecycleStateSchema.parse("completed")).toThrow();
      expect(() => executionLifecycleStateSchema.parse("aborted")).toThrow();
      expect(() => executionLifecycleStateSchema.parse("")).toThrow();
    });

    it("identifies terminal lifecycle states correctly", () => {
      expect(isTerminalExecutionLifecycleState("succeeded")).toBe(true);
      expect(isTerminalExecutionLifecycleState("failed")).toBe(true);
      expect(isTerminalExecutionLifecycleState("cancelled")).toBe(true);
      expect(isTerminalExecutionLifecycleState("degraded")).toBe(true);

      expect(isTerminalExecutionLifecycleState("queued")).toBe(false);
      expect(isTerminalExecutionLifecycleState("running")).toBe(false);
      expect(isTerminalExecutionLifecycleState("awaiting_input")).toBe(false);
    });

    it("enforces canonical state transitions", () => {
      // Valid transitions
      expect(canTransitionExecutionLifecycle("queued", "running")).toBe(true);
      expect(canTransitionExecutionLifecycle("queued", "cancelled")).toBe(true);
      expect(canTransitionExecutionLifecycle("running", "awaiting_input")).toBe(true);
      expect(canTransitionExecutionLifecycle("running", "succeeded")).toBe(true);
      expect(canTransitionExecutionLifecycle("running", "failed")).toBe(true);
      expect(canTransitionExecutionLifecycle("running", "cancelled")).toBe(true);
      expect(canTransitionExecutionLifecycle("running", "degraded")).toBe(true);
      expect(canTransitionExecutionLifecycle("awaiting_input", "running")).toBe(true);
      expect(canTransitionExecutionLifecycle("awaiting_input", "failed")).toBe(true);
      expect(canTransitionExecutionLifecycle("awaiting_input", "cancelled")).toBe(true);

      // Terminal states have zero exit transitions
      expect(canTransitionExecutionLifecycle("succeeded", "running")).toBe(false);
      expect(canTransitionExecutionLifecycle("failed", "queued")).toBe(false);
      expect(canTransitionExecutionLifecycle("cancelled", "running")).toBe(false);
      expect(canTransitionExecutionLifecycle("degraded", "running")).toBe(false);

      // Invalid shortcuts
      expect(canTransitionExecutionLifecycle("queued", "succeeded")).toBe(false);
      expect(canTransitionExecutionLifecycle("awaiting_input", "succeeded")).toBe(false);
    });

    it("normalizes legacy and external statuses into canonical ExecutionLifecycleState", () => {
      expect(toExecutionLifecycleState("queued")).toBe("queued");
      expect(toExecutionLifecycleState("created")).toBe("queued");
      expect(toExecutionLifecycleState("pending")).toBe("queued");

      expect(toExecutionLifecycleState("running")).toBe("running");
      expect(toExecutionLifecycleState("active")).toBe("running");
      expect(toExecutionLifecycleState("publishing")).toBe("running");

      expect(toExecutionLifecycleState("awaiting_input")).toBe("awaiting_input");
      expect(toExecutionLifecycleState("awaiting_publish")).toBe("awaiting_input");
      expect(toExecutionLifecycleState("suspended")).toBe("awaiting_input");

      expect(toExecutionLifecycleState("succeeded")).toBe("succeeded");
      expect(toExecutionLifecycleState("published")).toBe("succeeded");
      expect(toExecutionLifecycleState("pass")).toBe("succeeded");

      expect(toExecutionLifecycleState("failed")).toBe("failed");
      expect(toExecutionLifecycleState("publish_failed")).toBe("failed");
      expect(toExecutionLifecycleState("error")).toBe("failed");

      expect(toExecutionLifecycleState("cancelled")).toBe("cancelled");
      expect(toExecutionLifecycleState("skipped")).toBe("cancelled");

      expect(toExecutionLifecycleState("degraded")).toBe("degraded");
      expect(toExecutionLifecycleState("timed_out")).toBe("degraded");
      expect(toExecutionLifecycleState("warn")).toBe("degraded");

      expect(() => toExecutionLifecycleState("nonexistent_state")).toThrow();
      expect(tryToExecutionLifecycleState("active")).toBe("running");
      expect(tryToExecutionLifecycleState("bogus")).toBeUndefined();
    });
  });

  describe("TerminalReason", () => {
    const validReasons: TerminalReason[] = [
      "completed",
      "user_cancelled",
      "timeout",
      "quota_exceeded",
      "fatal_error",
      "degraded_coverage",
    ];

    it("parses all 6 standard terminal reasons", () => {
      for (const reason of validReasons) {
        expect(terminalReasonSchema.parse(reason)).toBe(reason);
      }
    });

    it("rejects unknown terminal reasons", () => {
      expect(() => terminalReasonSchema.parse("abort")).toThrow();
      expect(() => terminalReasonSchema.parse("unknown")).toThrow();
      expect(() => terminalReasonSchema.parse("crash")).toThrow();
    });

    it("provides isTerminalReason guard and default terminal reasons", () => {
      expect(isTerminalReason("completed")).toBe(true);
      expect(isTerminalReason("user_cancelled")).toBe(true);
      expect(isTerminalReason("timeout")).toBe(true);
      expect(isTerminalReason("quota_exceeded")).toBe(true);
      expect(isTerminalReason("fatal_error")).toBe(true);
      expect(isTerminalReason("degraded_coverage")).toBe(true);
      expect(isTerminalReason("other")).toBe(false);

      expect(defaultTerminalReasonForState("succeeded")).toBe("completed");
      expect(defaultTerminalReasonForState("cancelled")).toBe("user_cancelled");
      expect(defaultTerminalReasonForState("failed")).toBe("fatal_error");
      expect(defaultTerminalReasonForState("degraded")).toBe("degraded_coverage");
      expect(defaultTerminalReasonForState("running")).toBeUndefined();
      expect(defaultTerminalReasonForState("queued")).toBeUndefined();
    });
  });

  describe("Provenance Trace Context & Association Interfaces", () => {
    const baseTrace = {
      correlationId: "corr_019203a1-2b3c-7d4e-9f8a-112233445566",
      runId: "run_alpha_42",
      startedAt: "2026-09-23T10:00:00.000Z",
    };

    it("parses unified executionTraceContextSchema", () => {
      const fullContext = {
        ...baseTrace,
        stepId: "synthesize_report",
        attemptNumber: 2,
        finishedAt: "2026-09-23T10:05:00.000Z",
      };
      const parsed = executionTraceContextSchema.parse(fullContext);
      expect(parsed.correlationId).toBe(baseTrace.correlationId);
      expect(parsed.runId).toBe(baseTrace.runId);
      expect(parsed.stepId).toBe("synthesize_report");
      expect(parsed.attemptNumber).toBe(2);

      // Rejects finishedAt earlier than startedAt
      expect(() =>
        executionTraceContextSchema.parse({
          ...fullContext,
          finishedAt: "2026-09-23T09:59:59.000Z",
        }),
      ).toThrow(/finishedAt must not be earlier than startedAt/);
    });

    it("validates runExecutionTraceSchema", () => {
      const runTrace = runExecutionTraceSchema.parse({
        ...baseTrace,
        finishedAt: "2026-09-23T10:10:00.000Z",
      });
      expect(runTrace.runId).toBe("run_alpha_42");
      expect(() =>
        runExecutionTraceSchema.parse({
          ...baseTrace,
          correlationId: "",
        }),
      ).toThrow();
    });

    it("validates stepExecutionTraceSchema and factory helper", () => {
      const stepTrace = createStepTrace(baseTrace, "step_ast_analyze", baseTrace.startedAt);
      expect(stepTrace.stepId).toBe("step_ast_analyze");
      expect(stepTrace.correlationId).toBe(baseTrace.correlationId);

      const parsed = stepExecutionTraceSchema.parse(stepTrace);
      expect(parsed.stepId).toBe("step_ast_analyze");
    });

    it("validates attemptExecutionTraceSchema and factory helper", () => {
      const stepTrace = createStepTrace(baseTrace, "step_ast_analyze", baseTrace.startedAt);
      const attemptTrace = createAttemptTrace(stepTrace, 1, baseTrace.startedAt);

      expect(attemptTrace.attemptNumber).toBe(1);
      expect(attemptTrace.stepId).toBe("step_ast_analyze");

      const parsed = attemptExecutionTraceSchema.parse(attemptTrace);
      expect(parsed.attemptNumber).toBe(1);

      // Attempt number must be positive integer
      expect(() =>
        attemptExecutionTraceSchema.parse({
          ...attemptTrace,
          attemptNumber: 0,
        }),
      ).toThrow();
    });

    it("parses execution records for run, step, and attempt", () => {
      const runRecord = executionRunRecordSchema.parse({
        correlationId: baseTrace.correlationId,
        runId: baseTrace.runId,
        lifecycleState: "succeeded",
        terminalReason: "completed",
        startedAt: baseTrace.startedAt,
        finishedAt: "2026-09-23T10:02:00.000Z",
        metadata: { trigger: "ci" },
      });
      expect(runRecord.lifecycleState).toBe("succeeded");

      const stepRecord = executionStepRecordSchema.parse({
        correlationId: baseTrace.correlationId,
        runId: baseTrace.runId,
        stepId: "semgrep_scanner",
        lifecycleState: "failed",
        terminalReason: "fatal_error",
        attemptNumber: 1,
        startedAt: baseTrace.startedAt,
        error: "Process exited with code 1",
      });
      expect(stepRecord.error).toBe("Process exited with code 1");

      const attemptRecord = executionAttemptRecordSchema.parse({
        correlationId: baseTrace.correlationId,
        runId: baseTrace.runId,
        stepId: "semgrep_scanner",
        attemptNumber: 2,
        lifecycleState: "succeeded",
        terminalReason: "completed",
        startedAt: "2026-09-23T10:02:00.000Z",
        finishedAt: "2026-09-23T10:02:15.000Z",
      });
      expect(attemptRecord.attemptNumber).toBe(2);
    });

    it("validates executionLifecycleEventSchema for persistent audit trails", () => {
      const event = executionLifecycleEventSchema.parse({
        eventId: "evt_1001",
        correlationId: baseTrace.correlationId,
        runId: baseTrace.runId,
        stepId: "semgrep_scanner",
        attemptNumber: 1,
        fromState: "running",
        toState: "failed",
        terminalReason: "timeout",
        timestamp: "2026-09-23T10:01:30.000Z",
        error: "Execution exceeded timeout budget of 60000ms",
        payload: { timeoutMs: 60000 },
      });
      expect(event.toState).toBe("failed");
      expect(event.terminalReason).toBe("timeout");
    });
  });

  describe("Backward Compatibility", () => {
    it("preserves reviewJobSchema without lifecycle/correlation metadata", () => {
      const legacyJob = {
        id: "job_pr_123",
        type: "PR_REVIEW" as const,
        status: "running" as const,
        repositoryFullName: "owner/repo",
        pullRequestNumber: 10,
        baseSha: "abc0001",
        headSha: "def0002",
        accessMode: "github_app" as const,
        publicationPolicy: "github_comment" as const,
        createdAt: "2026-09-23T10:00:00.000Z",
      };

      const parsedLegacy = reviewJobSchema.parse(legacyJob);
      expect(parsedLegacy.id).toBe("job_pr_123");
      expect(parsedLegacy.correlationId).toBeUndefined();
      expect(parsedLegacy.lifecycleState).toBeUndefined();
      expect(parsedLegacy.terminalReason).toBeUndefined();
    });

    it("supports reviewJobSchema with enhanced execution lifecycle and correlation metadata", () => {
      const enhancedJob = {
        id: "job_pr_124",
        type: "PR_REVIEW" as const,
        status: "succeeded" as const,
        repositoryFullName: "owner/repo",
        pullRequestNumber: 11,
        baseSha: "abc0001",
        headSha: "def0002",
        accessMode: "github_app" as const,
        publicationPolicy: "github_comment" as const,
        createdAt: "2026-09-23T10:00:00.000Z",
        startedAt: "2026-09-23T10:00:05.000Z",
        finishedAt: "2026-09-23T10:01:00.000Z",
        correlationId: "corr_019203a1",
        lifecycleState: "succeeded" as const,
        terminalReason: "completed" as const,
      };

      const parsedEnhanced = reviewJobSchema.parse(enhancedJob);
      expect(parsedEnhanced.correlationId).toBe("corr_019203a1");
      expect(parsedEnhanced.lifecycleState).toBe("succeeded");
      expect(parsedEnhanced.terminalReason).toBe("completed");
    });

    it("retains reviewJobSchema strictness against unexpected fields", () => {
      const invalidJob = {
        id: "job_pr_125",
        type: "PR_REVIEW" as const,
        status: "queued" as const,
        repositoryFullName: "owner/repo",
        pullRequestNumber: 12,
        baseSha: "abc0001",
        headSha: "def0002",
        accessMode: "github_app" as const,
        publicationPolicy: "github_comment" as const,
        createdAt: "2026-09-23T10:00:00.000Z",
        arbitraryUnrecognizedField: "fail_closed",
      };
      expect(() => reviewJobSchema.parse(invalidJob)).toThrow();
    });

    it("preserves workflowRuntimeRunSchema with and without enhanced metadata", () => {
      const legacyRun = {
        runId: "wfrun_001",
        definitionId: "def_review_v1",
        status: "running" as const,
        createdAt: "2026-09-23T10:00:00.000Z",
        snapshot: {
          repository: "owner/repo",
          headSha: "head123",
        },
        evidence: [],
      };

      const parsedLegacy = workflowRuntimeRunSchema.parse(legacyRun);
      expect(parsedLegacy.runId).toBe("wfrun_001");
      expect(parsedLegacy.correlationId).toBeUndefined();
      expect(parsedLegacy.lifecycleState).toBeUndefined();

      const modernRun = {
        ...legacyRun,
        runId: "wfrun_002",
        status: "succeeded" as const,
        finishedAt: "2026-09-23T10:02:00.000Z",
        correlationId: "corr_wf_002",
        lifecycleState: "succeeded" as const,
        terminalReason: "completed" as const,
        startedAt: "2026-09-23T10:00:05.000Z",
      };

      const parsedModern = workflowRuntimeRunSchema.parse(modernRun);
      expect(parsedModern.correlationId).toBe("corr_wf_002");
      expect(parsedModern.lifecycleState).toBe("succeeded");
      expect(parsedModern.terminalReason).toBe("completed");

      const v2Run = workflowRuntimeRunV2Schema.parse({
        ...modernRun,
        revisionId: "rev_1",
        origin: "builtin" as const,
      });
      expect(v2Run.correlationId).toBe("corr_wf_002");
    });

    it("preserves workflowRuntimeRunSummarySchema and runtimeRunSummarySchema", () => {
      const summary = workflowRuntimeRunSummarySchema.parse({
        runId: "wfrun_sum_1",
        definitionId: "def_1",
        revisionId: "rev_1",
        status: "succeeded" as const,
        createdAt: "2026-09-23T10:00:00.000Z",
        repository: "owner/repo",
        headSha: "head123",
        findingCount: 3,
        evidenceCount: 5,
        correlationId: "corr_sum_1",
        lifecycleState: "succeeded" as const,
        terminalReason: "completed" as const,
      });
      expect(summary.findingCount).toBe(3);
      expect(summary.correlationId).toBe("corr_sum_1");

      const runSnapshot = runRuntimeSnapshotSchema.parse({
        runId: "run_snap_1",
        workloadKind: "review",
        state: "COMPLETED",
        createdAt: "2026-09-23T10:00:00.000Z",
        agentCounts: { total: 1, running: 0, waiting: 0, terminal: 1 },
        concurrency: 4,
        telemetryStatus: "completed" as const,
        securityGuarantees: {
          processMemoryIsolation: "not-enforced" as const,
          parentEnvSecretIsolation: "not-enforced" as const,
          kernelRpcAuthorization: "not-enforced" as const,
          filesystemOsContainment: "not-enforced" as const,
          networkOsContainment: "not-enforced" as const,
          subprocessOsContainment: "not-enforced" as const,
        },
        agents: [],
        correlationId: "corr_snap_1",
        lifecycleState: "succeeded" as const,
        terminalReason: "completed" as const,
      });
      expect(runSnapshot.correlationId).toBe("corr_snap_1");

      const runtimeSummary = runtimeRunSummarySchema.parse({
        runId: "run_snap_1",
        workloadKind: "review",
        state: "COMPLETED",
        createdAt: "2026-09-23T10:00:00.000Z",
        telemetryStatus: "completed" as const,
        agentCounts: { total: 1, running: 0, waiting: 0, terminal: 1 },
        correlationId: "corr_snap_1",
        lifecycleState: "succeeded" as const,
        terminalReason: "completed" as const,
      });
      expect(runtimeSummary.correlationId).toBe("corr_snap_1");
    });
  });
});
