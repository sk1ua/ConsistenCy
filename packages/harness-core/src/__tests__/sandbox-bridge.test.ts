import { describe, it, expect } from "vitest";
import {
  KernelScheduler,
  SandboxLifecycleBus,
  asRunId,
  asAgentId,
  makePrincipalId,
} from "@consistency/kernel";
import { SandboxAgentBridge } from "../runtime/sandbox-bridge.js";

describe("SandboxAgentBridge", () => {
  it("transitions Agent state to FAILED when sandbox session fails or times out", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_sbx") });
    scheduler.activateRun(run.id);

    const principal = { id: makePrincipalId("agent", "worker", "run_sbx"), kind: "agent" as const, runId: "run_sbx" };
    const agentId = asAgentId("agent_worker");
    scheduler.registerAgent({
      id: agentId,
      runId: run.id,
      priority: 1,
      executionDomain: "child-process",
    });

    scheduler.ready(agentId);
    scheduler.admit();
    expect(scheduler.getAgent(agentId)?.state).toBe("RUNNING");

    const bus = new SandboxLifecycleBus();
    const bridge = new SandboxAgentBridge(bus, scheduler);

    bus.emit({
      type: "session.failed",
      timestamp: Date.now(),
      sessionId: "sbx_123" as never,
      state: "failed",
      principalId: principal.id,
      runId: run.id,
      agentId,
      terminationReason: "crash",
      errorCode: "crash",
    });

    expect(scheduler.getAgent(agentId)?.state).toBe("FAILED");
    bridge.dispose();
  });

  it("transitions Agent state to CANCELLED when sandbox session is cancelled", () => {
    const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
    const run = scheduler.registerRun({ id: asRunId("run_sbx_2") });
    scheduler.activateRun(run.id);

    const agentId = asAgentId("agent_worker_2");
    scheduler.registerAgent({
      id: agentId,
      runId: run.id,
      priority: 1,
      executionDomain: "child-process",
    });

    scheduler.ready(agentId);
    scheduler.admit();
    expect(scheduler.getAgent(agentId)?.state).toBe("RUNNING");

    const bus = new SandboxLifecycleBus();
    const bridge = new SandboxAgentBridge(bus, scheduler);

    bus.emit({
      type: "session.cancelled",
      timestamp: Date.now(),
      sessionId: "sbx_456" as never,
      state: "cancelled",
      principalId: "agent:worker_2:run_sbx_2" as never,
      runId: run.id,
      agentId,
      terminationReason: "cancelled",
    });

    expect(scheduler.getAgent(agentId)?.state).toBe("CANCELLED");
    bridge.dispose();
  });
});
