import { createHash, randomUUID } from "node:crypto";
import {
  repositoryEventPlanningResultSchema,
  type AuditRunPlanningResult,
  type Automation,
  type PlanAuditRunDraftRequest,
  type RepositoryEvent,
  type RepositoryEventPlanningResult,
} from "@consistency/schema";
import { AuditDomainError, type AuditDomainStore } from "./store";

type AuditRunPlannerStore = Pick<
  AuditDomainStore,
  | "getAutomation"
  | "getRepositoryEvent"
  | "getWorkflowRevision"
  | "listAutomations"
  | "planAuditRunDraft"
>;

export type AuditRunPlannerDependencies = {
  /** Tests may inject a stable nonce to exercise manual-request idempotency. */
  createManualNonce?: () => string;
};

const EVENT_PLANNING_KEY_DOMAIN = "consistency:audit-run-planning:repository-event:v1";
const MANUAL_PLANNING_KEY_DOMAIN = "consistency:audit-run-planning:manual:v1";
const SCHEDULE_PLANNING_KEY_DOMAIN = "consistency:audit-run-planning:schedule:v1";

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable across RepositoryEvent replay and process restart. */
export function repositoryEventPlanningKey(
  event: Pick<RepositoryEvent, "repositoryId" | "dedupeKey">,
  automationId: string,
  workflowDigest: string
): string {
  return sha256([
    EVENT_PLANNING_KEY_DOMAIN,
    event.repositoryId,
    event.dedupeKey,
    automationId,
    workflowDigest
  ]);
}

export function schedulePlanningKey(
  automationId: string,
  workflowDigest: string,
  scheduledFor: string
): string {
  return sha256([SCHEDULE_PLANNING_KEY_DOMAIN, automationId, workflowDigest, scheduledFor]);
}

type PlannedWorkflowIdentity = {
  workflowRevisionId?: string;
  workflowDigest: string;
};

function workflowForAutomation(
  store: AuditRunPlannerStore,
  automation: Automation
): PlannedWorkflowIdentity {
  if (automation.workflowRevisionId !== undefined) {
    const workflow = store.getWorkflowRevision(automation.workflowRevisionId);
    if (workflow === undefined) {
      throw new AuditDomainError(
        "Automation references an unavailable workflow revision",
        "INVALID_AUDIT_RUN_REFERENCE",
        409
      );
    }
    return { workflowRevisionId: workflow.id, workflowDigest: workflow.digest };
  }
  if (automation.runtimeDefinitionId === undefined) {
    throw new AuditDomainError(
      "Automation has no executable workflow identity",
      "INVALID_AUDIT_RUN_REFERENCE",
      409
    );
  }
  // Runtime-only plans are namespaced identities, never fabricated legacy IDs.
  return {
    workflowDigest: sha256(`runtime:${automation.runtimeDefinitionId}`)
  };
}

/**
 * Durable planning only. This service never starts an executor, evaluates a
 * workflow, checks out code, or creates schedule timers.
 */
export class AuditRunPlanner {
  private readonly createManualNonce: () => string;

  constructor(
    private readonly store: AuditRunPlannerStore,
    dependencies: AuditRunPlannerDependencies = {}
  ) {
    this.createManualNonce = dependencies.createManualNonce ?? randomUUID;
  }

  planRepositoryEvent(event: RepositoryEvent): RepositoryEventPlanningResult {
    const persisted = this.store.getRepositoryEvent(event.id);
    if (
      persisted === undefined
      || persisted.repositoryId !== event.repositoryId
      || persisted.dedupeKey !== event.dedupeKey
    ) {
      throw new AuditDomainError(
        "Repository event must be persisted before audit-run planning",
        "REPOSITORY_EVENT_NOT_PERSISTED",
        409
      );
    }

    const matching = this.store.listAutomations(persisted.repositoryId)
      .filter(automation => (
        automation.enabled
        && automation.repositoryId === persisted.repositoryId
        && automation.trigger.type === "repository_event"
        && automation.trigger.eventTypes.includes(persisted.type)
      ))
      .sort((left, right) => left.id.localeCompare(right.id));
    const results = matching.map(automation => {
      const identity = workflowForAutomation(this.store, automation);
      return this.store.planAuditRunDraft({
        planningKey: repositoryEventPlanningKey(persisted, automation.id, identity.workflowDigest),
        repositoryId: persisted.repositoryId,
        automationId: automation.id,
        ...identity,
        policyRevisionId: automation.policyRevisionId,
        executionProfile: automation.executionProfile,
        source: "repository_event",
        sourceEventId: persisted.id,
        baseRevision: persisted.baseRevision,
        headRevision: persisted.headRevision
      });
    });

    return repositoryEventPlanningResultSchema.parse({
      eventId: persisted.id,
      matchedAutomationCount: results.length,
      results
    });
  }

  planManualRun(automationId: string): AuditRunPlanningResult {
    const automation = this.store.getAutomation(automationId);
    if (automation === undefined) {
      throw new AuditDomainError("Automation not found", "AUTOMATION_NOT_FOUND", 404);
    }
    const identity = workflowForAutomation(this.store, automation);
    const input: PlanAuditRunDraftRequest = {
      planningKey: sha256([
        MANUAL_PLANNING_KEY_DOMAIN,
        automation.id,
        identity.workflowDigest,
        this.createManualNonce()
      ]),
      repositoryId: automation.repositoryId,
      automationId: automation.id,
      ...identity,
      policyRevisionId: automation.policyRevisionId,
      executionProfile: automation.executionProfile,
      source: "manual"
    };
    return this.store.planAuditRunDraft(input);
  }

  planScheduleRun(automationId: string, scheduledFor: string): AuditRunPlanningResult {
    const automation = this.store.getAutomation(automationId);
    if (automation === undefined) {
      throw new AuditDomainError("Automation not found", "AUTOMATION_NOT_FOUND", 404);
    }
    const identity = workflowForAutomation(this.store, automation);
    return this.store.planAuditRunDraft({
      planningKey: schedulePlanningKey(automation.id, identity.workflowDigest, scheduledFor),
      repositoryId: automation.repositoryId,
      automationId: automation.id,
      ...identity,
      policyRevisionId: automation.policyRevisionId,
      executionProfile: automation.executionProfile,
      source: "schedule",
      scheduledFor
    });
  }
}
