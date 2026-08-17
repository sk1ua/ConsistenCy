/**
 * PR-6B Task Manager / Runtime Observability Integration Tests (AC-TM-1..18).
 *
 * Covers:
 *   - Live & Completed RunRuntimeSnapshot DTO generation
 *   - Real ACB states, process tree hierarchy, concurrency, and pending operations
 *   - WAIT_LLM (§47) and WAIT_TOOL live observability
 *   - Context VM metadata, residency counts, WorkingSet tokens, and page privacy
 *   - Sandbox child-process status and Sandbox-to-ACB failure bridge (§38, §48, AC-TM-14, AC-TM-15)
 *   - Truthful security guarantees (filesystem/network/subprocess = not-enforced)
 *   - Legacy/Pre-v3 Run fallback (telemetryStatus = "unavailable")
 *   - Recursive secret scan on runtime API responses (AC-TM-18)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import {
  asAgentId,
  asContextImageId,
  asRunId,
  asSandboxSessionId,
  CapabilityBroker,
  ContextManager,
  KernelScheduler,
  makePrincipalId,
  MemoryJournal,
  SandboxLifecycleBus,
  SandboxManager,
  SyscallGateway,
  type AgentSnapshot,
  type BoundOperation,
  type Principal,
  type TrustedOperationHandler,
} from "@consistency/kernel";
import { SandboxAgentBridge, buildRunRuntimeSnapshot } from "@consistency/harness-core";
import { DEFAULT_SECURITY_GUARANTEES, type RunRuntimeSnapshot } from "@consistency/schema";
import { createApiServer } from "../http";
import { InMemoryJobQueue } from "../jobQueue";
import { RuntimeRegistry } from "./runtimeRegistry";

const activeManagers: SandboxManager[] = [];

afterEach(() => {
  for (const manager of activeManagers.splice(0)) {
    manager.terminateAll();
  }
  vi.restoreAllMocks();
});

function recursiveFindSecrets(obj: unknown, secrets: string[]): string[] {
  const found: string[] = [];
  if (!obj) return found;

  if (typeof obj === "string") {
    for (const secret of secrets) {
      if (secret && obj.includes(secret)) {
        found.push(secret);
      }
    }
    if (/cap_[0-9a-f]{64}/i.test(obj)) {
      found.push("raw_capability_handle");
    }
    return found;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      found.push(...recursiveFindSecrets(item, secrets));
    }
    return found;
  }

  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (/handle|key|token|secret|password/i.test(key) && typeof val === "string") {
        if (/cap_[0-9a-f]{64}|ghp_[a-z0-9]+|ghs_[a-z0-9]+|sk-[a-z0-9]+/i.test(val)) {
          found.push(`${key}:${val}`);
        }
      }
      found.push(...recursiveFindSecrets(val, secrets));
    }
  }

  return found;
}

describe("PR-6B Task Manager / Runtime Observability (AC-TM-1..18)", () => {
  it("AC-TM-1..4: ReviewJob maps to Kernel Run snapshot with correct ACB tree, states, and concurrency", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_review_1") });
    scheduler.activateRun(run.id);

    // Parent supervisor agent
    const supId = asAgentId("agent_supervisor");
    scheduler.registerAgent({
      id: supId,
      runId: run.id,
      priority: 10,
      executionDomain: "in-process",
    });
    scheduler.ready(supId);
    scheduler.admit(); // RUNNING

    // Child security agent
    const secId = asAgentId("agent_security");
    scheduler.registerAgent({
      id: secId,
      runId: run.id,
      parent: supId,
      priority: 5,
      executionDomain: "in-process",
    });
    scheduler.ready(secId); // READY

    const snapshot = buildRunRuntimeSnapshot({
      runId: run.id,
      workloadKind: "pr_review",
      jobId: "job_123",
      scheduler,
      telemetryStatus: "live",
    });

    expect(snapshot.runId).toBe("run_review_1");
    expect(snapshot.jobId).toBe("job_123");
    expect(snapshot.concurrency).toBe(2);
    expect(snapshot.agentCounts.total).toBe(2);
    expect(snapshot.agentCounts.running).toBe(1); // Supervisor
    expect(snapshot.agentCounts.waiting).toBe(0);

    // Parent/child tree hierarchy
    expect(snapshot.agents[0]!.agentId).toBe("agent_supervisor");
    expect(snapshot.agents[0]!.state).toBe("RUNNING");
    expect(snapshot.agents[0]!.children).toContain("agent_security");

    expect(snapshot.agents[1]!.agentId).toBe("agent_security");
    expect(snapshot.agents[1]!.parent).toBe("agent_supervisor");
    expect(snapshot.agents[1]!.state).toBe("READY");
  });

  it("AC-TM-5 (§47): LIVE WAIT_LLM state is observable during a blocked fake model call, then completes", async () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_live_llm") });
    scheduler.activateRun(run.id);

    const agentId = asAgentId("agent_llm");
    scheduler.registerAgent({
      id: agentId,
      runId: run.id,
      priority: 1,
      executionDomain: "in-process",
    });

    scheduler.ready(agentId);
    scheduler.admit(); // RUNNING

    // Transition to WAIT_LLM
    scheduler.wait(agentId, { kind: "llm", provider: "openai", model: "gpt-4o" });
    expect(scheduler.getAgent(agentId)?.state).toBe("WAIT_LLM");

    const registry = new RuntimeRegistry();
    registry.registerLiveRun({
      runId: run.id,
      jobId: "job_llm",
      workloadKind: "pr_review",
      scheduler,
    });

    // 1. Observe LIVE while blocked in WAIT_LLM
    const liveSnapshot = registry.getSnapshot("job_llm")!;
    expect(liveSnapshot.telemetryStatus).toBe("live");
    expect(liveSnapshot.state).toBe("ACTIVE");
    const agentSnap = liveSnapshot.agents.find((a) => a.agentId === "agent_llm")!;
    expect(agentSnap.state).toBe("WAIT_LLM");
    expect(agentSnap.pendingOperation?.kind).toBe("llm");
    expect(agentSnap.pendingOperation?.description).toContain("openai");

    // 2. Resolve fake LLM call: wake → admit → succeed
    scheduler.wake(agentId);
    scheduler.admit();
    scheduler.succeedAgent(agentId);
    scheduler.succeedRun(run.id);

    // Complete run in registry
    const completedSnapshot = registry.completeRun(run.id)!;
    expect(completedSnapshot.telemetryStatus).toBe("completed");
    expect(completedSnapshot.state).toBe("SUCCEEDED");
    expect(completedSnapshot.agents.find((a) => a.agentId === "agent_llm")?.state).toBe("SUCCEEDED");
  });

  it("AC-TM-6: LIVE WAIT_TOOL state is observable during a blocked tool call", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 1 });
    const run = scheduler.registerRun({ id: asRunId("run_tool") });
    scheduler.activateRun(run.id);

    const agentId = asAgentId("agent_tool");
    scheduler.registerAgent({ id: agentId, runId: run.id, priority: 1, executionDomain: "in-process" });
    scheduler.ready(agentId);
    scheduler.admit();

    scheduler.wait(agentId, { kind: "tool", toolName: "git.diff" });

    const snapshot = buildRunRuntimeSnapshot({
      runId: run.id,
      workloadKind: "pr_review",
      scheduler,
      telemetryStatus: "live",
    });

    const agentSnap = snapshot.agents.find((a) => a.agentId === "agent_tool")!;
    expect(agentSnap.state).toBe("WAIT_TOOL");
    expect(agentSnap.pendingOperation?.kind).toBe("tool");
    expect(agentSnap.pendingOperation?.description).toContain("git.diff");
  });

  it("AC-TM-7: final SUCCEEDED and FAILED states remain available in completed snapshot", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_completed") });
    scheduler.activateRun(run.id);

    const agentA = asAgentId("agent_succeeded");
    const agentB = asAgentId("agent_failed");

    scheduler.registerAgent({ id: agentA, runId: run.id, priority: 1, executionDomain: "in-process" });
    scheduler.registerAgent({ id: agentB, runId: run.id, priority: 1, executionDomain: "in-process" });

    scheduler.ready(agentA);
    scheduler.admit();
    scheduler.succeedAgent(agentA);

    scheduler.ready(agentB);
    scheduler.admit();
    scheduler.failAgent(agentB);

    scheduler.failRun(run.id);

    const registry = new RuntimeRegistry();
    registry.registerLiveRun({ runId: run.id, workloadKind: "pr_review", scheduler });
    const completed = registry.completeRun(run.id)!;

    expect(completed.telemetryStatus).toBe("completed");
    expect(completed.state).toBe("FAILED");
    expect(completed.agents.find((a) => a.agentId === "agent_succeeded")?.state).toBe("SUCCEEDED");
    expect(completed.agents.find((a) => a.agentId === "agent_failed")?.state).toBe("FAILED");
  });

  it("AC-TM-8..9: capability descriptors contain 12-char fingerprints and revoked status, NO raw handles", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const scheduler = new KernelScheduler({ maxRunningAgents: 1 });
    const run = scheduler.registerRun({ id: asRunId("run_cap") });
    scheduler.activateRun(run.id);

    const principal: Principal = {
      id: makePrincipalId("agent", "Security", run.id),
      kind: "agent",
      runId: run.id,
    };
    const agentId = asAgentId("agent_sec");
    scheduler.registerAgent({ id: agentId, runId: run.id, priority: 1, executionDomain: "in-process" });

    const handleA = broker.issue({
      subject: principal,
      action: "repo.read",
      resource: { kind: "repository", id: "owner/repo" },
      scope: { sha: "abc1234", paths: ["src/**"] },
    });

    const handleB = broker.issue({
      subject: principal,
      action: "llm.invoke",
      resource: { kind: "llm", provider: "openai" },
    });

    // Revoke handleB
    broker.revoke(handleB, makePrincipalId("kernel", "admin"));

    const snapshot = buildRunRuntimeSnapshot({
      runId: run.id,
      workloadKind: "pr_review",
      scheduler,
      broker,
      agentLabels: new Map([["agent_sec", "Security"]]),
      telemetryStatus: "live",
    });

    const agentSnap = snapshot.agents.find((a) => a.agentId === "agent_sec")!;
    expect(agentSnap.capabilities).toHaveLength(2);

    const rawJson = JSON.stringify(snapshot);
    expect(rawJson).not.toContain(handleA);
    expect(rawJson).not.toContain(handleB);
    expect(rawJson).not.toContain("cap_");

    const repoCap = agentSnap.capabilities.find((c) => c.action === "repo.read")!;
    expect(repoCap.handleFingerprint).toHaveLength(12);
    expect(repoCap.scope?.sha).toBe("abc1234");
    expect(repoCap.revoked).toBe(false);

    const llmCap = agentSnap.capabilities.find((c) => c.action === "llm.invoke")!;
    expect(llmCap.revoked).toBe(true);
  });

  it("AC-TM-10..12: Context VM metadata, residency counts, and WorkingSet tokens match projection, NO source text", () => {
    const cm = new ContextManager();
    const baseId = cm.createImage();

    const page1 = cm.createPage({
      kind: "policy",
      text: "RULE: No raw secrets in source code.",
      estimatedTokens: 10,
      provenance: { producer: "policy-loader", producerVersion: "1.0.0" },
    });
    const page2 = cm.createPage({
      kind: "source",
      text: "export const SUPER_SECRET_SOURCE_TEXT = 'do_not_leak_me';",
      estimatedTokens: 25,
      source: { kind: "repository", repository: "owner/repo", sha: "head123", path: "src/secret.ts" },
      provenance: { producer: "repo-loader", producerVersion: "1.0.0" },
    });

    cm.attach(baseId, page1, "pinned");
    cm.attach(baseId, page2, "hot");

    const scheduler = new KernelScheduler({ maxRunningAgents: 1 });
    const run = scheduler.registerRun({ id: asRunId("run_vm") });

    const snapshot = buildRunRuntimeSnapshot({
      runId: run.id,
      workloadKind: "pr_review",
      scheduler,
      contextManager: cm,
      baseContextImageId: baseId,
      telemetryStatus: "live",
    });

    expect(snapshot.context).toBeDefined();
    expect(snapshot.context!.workingSetTokens).toBe(35); // 10 + 25
    expect(snapshot.context!.workingSetPageCount).toBe(2);
    expect(snapshot.context!.pageCountsByResidency["pinned"]).toBe(1);
    expect(snapshot.context!.pageCountsByResidency["hot"]).toBe(1);

    // Page metadata
    expect(snapshot.context!.pages).toHaveLength(2);
    const sourcePage = snapshot.context!.pages.find((p) => p.kind === "source")!;
    expect(sourcePage.contentHash).toHaveLength(12);
    expect(sourcePage.sourceRef).toBe("src/secret.ts");

    // NO full source text
    const jsonText = JSON.stringify(snapshot);
    expect(jsonText).not.toContain("SUPER_SECRET_SOURCE_TEXT");
    expect(jsonText).not.toContain("do_not_leak_me");
  });

  it("AC-TM-13..15 (§38, §48): Sandbox child process status and failure bridge propagate to Agent FAILED state", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_sandbox_bridge") });
    scheduler.activateRun(run.id);

    const bus = new SandboxLifecycleBus();
    const sandboxBridge = new SandboxAgentBridge(bus, scheduler);

    const principal: Principal = {
      id: makePrincipalId("agent", "child-plugin", run.id),
      kind: "agent",
      runId: run.id,
    };
    const agentId = asAgentId("agent_child");
    scheduler.registerAgent({
      id: agentId,
      runId: run.id,
      priority: 1,
      executionDomain: "child-process",
    });

    scheduler.ready(agentId);
    scheduler.admit();
    expect(scheduler.getAgent(agentId)?.state).toBe("RUNNING");

    // Emit sandbox failure
    bus.emit({
      type: "session.failed",
      timestamp: Date.now(),
      sessionId: asSandboxSessionId("sbx_crash_1"),
      state: "failed",
      principalId: principal.id,
      runId: run.id,
      agentId,
      terminationReason: "crash",
      errorCode: "crash",
    });

    // Agent state updated to FAILED in KernelScheduler via bridge
    expect(scheduler.getAgent(agentId)?.state).toBe("FAILED");

    const snapshot = buildRunRuntimeSnapshot({
      runId: run.id,
      workloadKind: "pr_review",
      scheduler,
      telemetryStatus: "live",
    });

    const agentSnap = snapshot.agents.find((a) => a.agentId === "agent_child")!;
    expect(agentSnap.state).toBe("FAILED");
    expect(agentSnap.executionDomain).toBe("child-process");

    sandboxBridge.dispose();
  });

  it("AC-TM-16: security guarantees truthfully reflect process/secret isolation as ENFORCED, containment as NOT ENFORCED", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 1 });
    const run = scheduler.registerRun({ id: asRunId("run_sec") });

    const snapshot = buildRunRuntimeSnapshot({
      runId: run.id,
      workloadKind: "pr_review",
      scheduler,
      telemetryStatus: "live",
    });

    expect(snapshot.securityGuarantees).toEqual({
      processMemoryIsolation: "enforced",
      parentEnvSecretIsolation: "enforced",
      kernelRpcAuthorization: "enforced",
      filesystemOsContainment: "not-enforced",
      networkOsContainment: "not-enforced",
      subprocessOsContainment: "not-enforced",
    });
  });

  it("AC-TM-17: old ReviewJob without runtime telemetry returns telemetryStatus = 'unavailable', no fake ACBs", async () => {
    const jobs = new InMemoryJobQueue();
    const oldJob = jobs.enqueue({
      kind: "pull_request",
      repository: "owner/old-repo",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
    });

    const registry = new RuntimeRegistry();
    const server = createApiServer({
      jobs,
      runtimeRegistry: registry,
      apiToken: "secret-token",
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime/runs/${oldJob.id}`, {
        headers: { authorization: "Bearer secret-token" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunRuntimeSnapshot;
      expect(body.telemetryStatus).toBe("unavailable");
      expect(body.jobId).toBe(oldJob.id);
      expect(body.agents).toEqual([]); // NO fabricated ACBs!
      expect(body.agentCounts.total).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC-TM-18: runtime API response recursive secret scan passes", async () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_secret_scan") });
    scheduler.activateRun(run.id);

    const secretHandle = broker.issue({
      subject: { id: makePrincipalId("agent", "SecAgent", run.id), kind: "agent", runId: run.id },
      action: "repo.read",
      resource: { kind: "repository", id: "owner/repo" },
    });

    const agentId = asAgentId("agent_sec");
    scheduler.registerAgent({ id: agentId, runId: run.id, priority: 1, executionDomain: "in-process" });

    const registry = new RuntimeRegistry();
    registry.registerLiveRun({
      runId: run.id,
      jobId: "job_scan",
      workloadKind: "pr_review",
      scheduler,
      broker,
    });

    const server = createApiServer({
      runtimeRegistry: registry,
      apiToken: "secret-token",
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime/runs/${run.id}`, {
        headers: { authorization: "Bearer secret-token" },
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      const secretsToScan = [
        secretHandle,
        "ghp_SENSITIVE_GITHUB_PAT_TOKEN_12345",
        "ghs_SENSITIVE_INSTALLATION_TOKEN_67890",
        "sk-SENSITIVE_OPENAI_API_KEY_abcdef",
        "SECRET_ENV_PASSWORD_VAL",
      ];

      const found = recursiveFindSecrets(json, secretsToScan);
      expect(found).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
