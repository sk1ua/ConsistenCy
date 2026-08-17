/**
 * Harness / Workload Observability Snapshot Builder.
 *
 * Composes generic Kernel process snapshots (KernelRun, AgentControlBlock,
 * KernelScheduler, ContextManager, SandboxManager) into a sanitized, deeply
 * read-only `RunRuntimeSnapshot` DTO for host-side APIs and Web UI.
 *
 * STRICT SECURITY BOUNDARY:
 *   - NEVER exposes raw CapabilityHandles (`cap_<64hex>`) — only 12-char fingerprints.
 *   - NEVER exposes credentials, API keys, tokens, or process environments.
 *   - NEVER exposes full ContextPage source code text (only metadata & hashes).
 *   - Truthfully separates process memory / env isolation (ENFORCED) from OS
 *     filesystem / network / subprocess containment (NOT ENFORCED).
 */

import {
  auditFingerprint,
  makePrincipalId,
  TERMINAL_AGENT_STATES,
  WAIT_AGENT_STATES,
  type AgentSnapshot,
  type CapabilityBroker,
  type ContextImageId,
  type ContextManager,
  type KernelScheduler,
  type RunId,
  type SandboxManager,
  type SandboxSessionSnapshot,
} from "@consistency/kernel";
import {
  DEFAULT_SECURITY_GUARANTEES,
  type AgentRuntimeSnapshot,
  type CapabilityDescriptorSnapshot,
  type ContextPageMetadataSnapshot,
  type ContextVMRuntimeSnapshot,
  type PendingOperationSnapshot,
  type RunRuntimeSnapshot,
  type SandboxSessionRuntimeSnapshot,
  type SecurityGuarantees,
} from "@consistency/schema";

export interface BuildRunRuntimeSnapshotOptions {
  readonly runId: RunId;
  readonly workloadKind: string;
  readonly jobId?: string;
  readonly scheduler: KernelScheduler;
  readonly contextManager?: ContextManager;
  readonly baseContextImageId?: ContextImageId;
  readonly broker?: CapabilityBroker;
  readonly sandboxManager?: SandboxManager;
  readonly agentLabels?: ReadonlyMap<string, string> | Record<string, string>;
  readonly telemetryStatus: "live" | "completed" | "unavailable";
  readonly securityGuarantees?: SecurityGuarantees;
}

export function buildRunRuntimeSnapshot(options: BuildRunRuntimeSnapshotOptions): RunRuntimeSnapshot {
  const {
    runId,
    workloadKind,
    jobId,
    scheduler,
    contextManager,
    baseContextImageId,
    broker,
    sandboxManager,
    agentLabels,
    telemetryStatus,
    securityGuarantees = DEFAULT_SECURITY_GUARANTEES,
  } = options;

  const run = scheduler.getRun(runId);
  const createdAt = run ? new Date(run.createdAt).toISOString() : new Date().toISOString();

  const allRunAgents = scheduler.listAgents().filter((agent) => agent.runId === runId);

  const runningCount = allRunAgents.filter((agent) => agent.state === "RUNNING").length;
  const waitingCount = allRunAgents.filter((agent) => WAIT_AGENT_STATES.includes(agent.state)).length;
  const terminalCount = allRunAgents.filter((agent) => TERMINAL_AGENT_STATES.includes(agent.state)).length;

  const agentCounts = {
    total: allRunAgents.length,
    running: runningCount,
    waiting: waitingCount,
    terminal: terminalCount,
  };

  // Deterministic DFS tree ordering
  const orderedAgents = orderAgentsProcessTree(allRunAgents);

  const sandboxSessions = sandboxManager ? sandboxManager.list() : [];

  const agentSnapshots: AgentRuntimeSnapshot[] = orderedAgents.map((agent) => {
    const label = getAgentLabel(agent.id, agentLabels);
    const principalId = makePrincipalId("agent", label, runId);

    // Capabilities (safe descriptors only)
    let capabilities: CapabilityDescriptorSnapshot[] = [];
    if (broker) {
      const records = broker.getRecordsForSubject(principalId);
      capabilities = records.map((record) => {
        let resourceId: string | undefined;
        const resource = record.resource;
        if (resource.kind === "repository") resourceId = resource.id;
        else if (resource.kind === "github.publish") resourceId = resource.repositoryId;
        else if (resource.kind === "llm") resourceId = resource.provider;
        else if (resource.kind === "evidence") resourceId = resource.runId;
        else if (resource.kind === "workspace") resourceId = resource.runId;
        else if (resource.kind === "ast") resourceId = resource.snapshotId;

        return {
          action: record.action,
          resourceKind: record.resource.kind,
          resourceId,
          handleFingerprint: auditFingerprint(record.handle),
          revoked: record.revoked,
          scope: record.scope
            ? {
                sha: record.scope.sha,
                paths: record.scope.paths ? [...record.scope.paths] : undefined,
              }
            : undefined,
          expiresAt: record.expiresAt,
        };
      });
    } else {
      capabilities = agent.capabilities.map((ref) => ({
        action: ref.action,
        resourceKind: ref.resourceKind,
        handleFingerprint: ref.handleFingerprint,
      }));
    }

    // Sort capabilities deterministically
    capabilities.sort((a, b) => {
      const act = a.action.localeCompare(b.action);
      if (act !== 0) return act;
      const res = a.resourceKind.localeCompare(b.resourceKind);
      if (res !== 0) return res;
      return a.handleFingerprint.localeCompare(b.handleFingerprint);
    });

    // Sandbox
    let sandboxSnapshot: SandboxSessionRuntimeSnapshot | undefined;
    const matchingSandbox = sandboxSessions.find(
      (s) => s.agentId === agent.id || s.principalId === principalId,
    );
    if (matchingSandbox) {
      sandboxSnapshot = mapSandboxSnapshot(matchingSandbox);
    }

    // Pending operation
    let pendingOp: PendingOperationSnapshot | undefined;
    if (agent.pendingOperation) {
      const op = agent.pendingOperation;
      let description = "";
      if (op.kind === "llm") description = op.provider ? `LLM Provider (${op.provider})` : "LLM Inference";
      else if (op.kind === "tool") description = `Tool (${op.toolName})`;
      else if (op.kind === "io") description = op.description;
      else if (op.kind === "agent") description = `Agent (${op.target})`;
      else if (op.kind === "human") description = op.prompt;

      pendingOp = {
        kind: op.kind,
        description,
        startedAt: op.startedAt,
      };
    }

    const budgets =
      agent.tokenBudget !== undefined ||
      agent.costBudgetUsdMicros !== undefined ||
      agent.wallTimeBudgetMs !== undefined
        ? {
            tokenBudget: agent.tokenBudget,
            costBudgetUsdMicros: agent.costBudgetUsdMicros !== undefined ? String(agent.costBudgetUsdMicros) : undefined,
            wallTimeBudgetMs: agent.wallTimeBudgetMs,
          }
        : undefined;

    return {
      agentId: agent.id,
      label,
      state: agent.state,
      priority: agent.priority,
      parent: agent.parent,
      children: [...agent.children],
      logicalRing: agent.logicalRing,
      executionDomain: agent.executionDomain,
      pendingOperation: pendingOp,
      deadline: agent.deadline,
      createdAt: agent.createdAt,
      contextImageId: agent.contextImage,
      capabilities,
      budgets,
      sandbox: sandboxSnapshot,
    };
  });

  // Context VM Snapshot
  let contextSnapshot: ContextVMRuntimeSnapshot | undefined;
  if (contextManager) {
    const targetImageId =
      baseContextImageId ??
      allRunAgents.find((a) => a.contextImage)?.contextImage;

    if (targetImageId) {
      try {
        const workingSet = contextManager.workingSet(targetImageId);
        const pageCountsByKind: Record<string, number> = {};
        const pageCountsByResidency: Record<string, number> = {};

        const pages: ContextPageMetadataSnapshot[] = workingSet.pages.map((p) => {
          const page = p.page;
          const residency = p.residency;
          pageCountsByKind[page.kind] = (pageCountsByKind[page.kind] ?? 0) + 1;
          pageCountsByResidency[residency] = (pageCountsByResidency[residency] ?? 0) + 1;

          let sourceRef: string | undefined;
          if (page.source) {
            if (page.source.kind === "repository") {
              sourceRef = page.source.path;
            } else if (page.source.kind === "agent") {
              sourceRef = page.source.agentId;
            } else if (page.source.kind === "workload") {
              sourceRef = page.source.workload;
            }
          }

          return {
            pageId: page.id,
            kind: page.kind,
            residency,
            estimatedTokens: page.estimatedTokens,
            contentHash: page.contentHash.slice(0, 12),
            sourceRef,
          };
        });

        // Sort pages deterministically
        pages.sort((a, b) => {
          const k = a.kind.localeCompare(b.kind);
          if (k !== 0) return k;
          const r = a.residency.localeCompare(b.residency);
          if (r !== 0) return r;
          return a.pageId.localeCompare(b.pageId);
        });

        contextSnapshot = {
          baseContextImageId: targetImageId,
          workingSetTokens: workingSet.estimatedTokens,
          workingSetPageCount: workingSet.pages.length,
          pageCountsByKind,
          pageCountsByResidency,
          pages,
        };
      } catch {
        // Image not in manager
      }
    }
  }

  return {
    runId,
    workloadKind,
    jobId,
    state: run?.state ?? "COMPLETED",
    createdAt,
    deadline: run?.deadline,
    agentCounts,
    concurrency: scheduler.maxRunningAgents,
    telemetryStatus,
    securityGuarantees,
    agents: agentSnapshots,
    context: contextSnapshot,
  };
}

function orderAgentsProcessTree(agents: readonly AgentSnapshot[]): AgentSnapshot[] {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const visited = new Set<string>();
  const ordered: AgentSnapshot[] = [];

  const visit = (agentId: string) => {
    if (visited.has(agentId)) return;
    const agent = agentMap.get(agentId as import("@consistency/kernel").AgentId);
    if (!agent) return;
    visited.add(agentId);
    ordered.push(agent);

    const sortedChildren = [...agent.children].sort((a, b) => a.localeCompare(b));
    for (const childId of sortedChildren) {
      visit(childId);
    }
  };

  const roots = agents
    .filter((a) => !a.parent || !agentMap.has(a.parent))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const root of roots) {
    visit(root.id);
  }

  const remaining = agents.filter((a) => !visited.has(a.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const orphan of remaining) {
    visit(orphan.id);
  }

  return ordered;
}

function getAgentLabel(
  agentId: string,
  labels?: ReadonlyMap<string, string> | Record<string, string>,
): string {
  if (labels) {
    if (labels instanceof Map) {
      const found = labels.get(agentId);
      if (found) return found;
    } else if (typeof labels === "object" && agentId in labels) {
      const found = (labels as Record<string, string>)[agentId];
      if (found) return found;
    }
  }
  const parts = agentId.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1]!;
  }
  return agentId;
}

function mapSandboxSnapshot(s: SandboxSessionSnapshot): SandboxSessionRuntimeSnapshot {
  return {
    sessionId: s.id,
    state: s.state,
    pid: s.pid,
    pluginId: s.descriptorId,
    pluginVersion: "1.0.0",
    executionDomain: "child-process",
    terminationReason: s.terminationReason,
    protocolVersion: 1,
    errorCode: s.error?.code,
    diagnostics: s.diagnostics ? s.diagnostics.slice(-1024) : undefined,
  };
}
