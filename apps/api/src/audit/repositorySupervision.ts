import { createHash } from "node:crypto";
import type { Automation } from "@consistency/schema";
import type { RepositorySupervisorRegistration } from "../heartbeat/repositorySupervisor";
import type { AuditDomainStore } from "./store";

type RepositorySupervisionStore = Pick<
  AuditDomainStore,
  "listLocalRepositorySupervisionTargets" | "listAutomations" | "getWorkflowRevision"
>;

const DIGEST_DOMAIN = "consistency:repository-supervision:workflow-set:v1";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable configuration identity for a monitored repository with no enabled automations. */
export const EMPTY_REPOSITORY_WORKFLOW_DIGEST = createHash("sha256")
  .update(`${DIGEST_DOMAIN}:empty`)
  .digest("hex");

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot digest a non-finite automation value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort(compareCodeUnits)
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot digest automation value of type '${typeof value}'`);
}

function automationDigestMaterial(
  store: RepositorySupervisionStore,
  automation: Automation
): Record<string, unknown> {
  const workflowRevision = store.getWorkflowRevision(automation.workflowRevisionId);
  if (workflowRevision === undefined) {
    throw new Error(
      `Enabled automation '${automation.id}' references missing workflow revision '${automation.workflowRevisionId}'`
    );
  }
  return {
    automationId: automation.id,
    name: automation.name,
    trigger: automation.trigger,
    workflowRevisionId: automation.workflowRevisionId,
    workflowDigest: workflowRevision.digest,
    policyRevisionId: automation.policyRevisionId,
    executionProfile: automation.executionProfile,
    enabled: true
  };
}

function repositoryWorkflowDigest(
  store: RepositorySupervisionStore,
  repositoryId: string,
  onChangeDefinitionIds: readonly string[]
): string {
  const enabledAutomations = store.listAutomations(repositoryId).filter(automation => automation.enabled);
  const sortedBindings = [...onChangeDefinitionIds].sort(compareCodeUnits);
  if (enabledAutomations.length === 0 && sortedBindings.length === 0) return EMPTY_REPOSITORY_WORKFLOW_DIGEST;

  const serializedAutomations = enabledAutomations
    .map(automation => stableJson(automationDigestMaterial(store, automation)))
    .sort(compareCodeUnits);
  // Repositories without on_change workflow bindings keep the EXACT
  // pre-CKPT5 digest bytes: the bindings key joins the material only when
  // such bindings exist, so upgrading never re-arms events for unchanged
  // configuration. Binding identity is the definition id only — the executed
  // revision is resolved at execution time, not pinned at event time.
  const material = sortedBindings.length === 0
    ? { domain: DIGEST_DOMAIN, automations: serializedAutomations }
    : {
        domain: DIGEST_DOMAIN,
        automations: serializedAutomations,
        bindings: sortedBindings.map(definitionId => stableJson({ definitionId }))
      };
  return createHash("sha256").update(stableJson(material)).digest("hex");
}

/**
 * Builds the server-only registrations consumed by RepositorySupervisor.
 * This only composes persisted configuration; it does not inspect or execute repository code.
 * `onChangeBindings` supplies the enabled on_change workflow-runtime binding
 * definition ids per repository (CKPT5): their set is part of the
 * registration digest, so binding changes re-arm change events.
 */
export function buildRepositorySupervisorRegistrations(
  store: RepositorySupervisionStore,
  pollIntervalMs: number,
  options?: { onChangeBindings?: (repositoryId: string) => readonly string[] }
): RepositorySupervisorRegistration[] {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("pollIntervalMs must be a positive integer");
  }

  return store.listLocalRepositorySupervisionTargets()
    .filter(target => (
      target.repository.source === "local_git"
      && target.repository.monitoringEnabled
      && target.serverLocator.trim().length > 0
    ))
    .sort((left, right) => compareCodeUnits(left.repository.id, right.repository.id))
    .map(target => ({
      repositoryId: target.repository.id,
      root: target.serverLocator,
      workflowDigest: repositoryWorkflowDigest(
        store,
        target.repository.id,
        options?.onChangeBindings?.(target.repository.id) ?? []
      ),
      pollIntervalMs
    }));
}
