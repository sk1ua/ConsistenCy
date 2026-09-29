/**
 * H13 bridge cancellation tests — the Cordis adapter mirrors Scheduler cancel
 * decisions into fiber-visible aborts. The bridge NEVER decides cancellation:
 *
 *   B1  agent.cancelled → the agent's abort signal fires and `cancellation()`
 *       carries the Scheduler's single cancel causal id.
 *   B2  run.cancelled → EVERY attached agent of that run aborts with the same
 *       cancelId; agents of other runs are untouched.
 *   B3  execute() on an already-cancelled agent throws deterministically
 *       (carrying the cancelId) — queued work never starts.
 *   B4  a non-cancel state change never aborts the signal.
 */

import { describe, expect, it } from "vitest";
import { Context } from "cordis";
import { KernelScheduler, asAgentId, asRunId, makePrincipalId } from "@consistency/kernel";
import { SchedulerAgentBridge } from "../runtime/scheduler-bridge.js";

function makeRig(maxRunningAgents = 2) {
  const scheduler = new KernelScheduler({ maxRunningAgents });
  const bridge = new SchedulerAgentBridge(new Context(), scheduler);
  return { scheduler, bridge };
}

const PRINCIPAL = { id: makePrincipalId("agent", "h13-bridge", "run_h13"), kind: "agent" as const, runId: "run_h13" };

function attachAgent(rig: ReturnType<typeof makeRig>, agentId: string, runId = "run_h13") {
  const run = asRunId(runId);
  if (!rig.scheduler.getRun(run)) {
    rig.scheduler.registerRun({ id: run });
    rig.scheduler.activateRun(run);
  }
  const id = asAgentId(agentId);
  rig.scheduler.registerAgent({
    id,
    runId: run,
    priority: 0,
    executionDomain: "in-process",
  });
  return rig.bridge.attach({ ...PRINCIPAL, runId: String(run) }, id);
}

describe("SchedulerAgentBridge cancellation propagation (H13)", () => {
  it("B1: agent.cancelled aborts the fiber signal and carries the cancel causal id", async () => {
    const rig = makeRig();
    const handle = attachAgent(rig, "agent_b1");

    expect(handle.cancellation()).toEqual({ cancelled: false });
    expect(handle.signal.aborted).toBe(false);

    const cause = rig.scheduler.cancelAgent(handle.agentId);
    await rig.bridge.flush();

    expect(handle.signal.aborted).toBe(true);
    expect(handle.cancellation()).toEqual({ cancelled: true, cancelCauseId: cause.cancelId });
  });

  it("B2: run.cancelled aborts every agent of THAT run with the same cancelId, others untouched", async () => {
    const rig = makeRig();
    const mine = attachAgent(rig, "agent_mine", "run_h13");
    const other = attachAgent(rig, "agent_other", "run_other_h13");

    const cause = rig.scheduler.cancelRun(asRunId("run_h13"));
    await rig.bridge.flush();

    expect(mine.signal.aborted).toBe(true);
    expect(mine.cancellation().cancelCauseId).toBe(cause.cancelId);
    expect(other.signal.aborted).toBe(false);
    expect(other.cancellation().cancelled).toBe(false);
  });

  it("B3: execute() on an already-cancelled agent throws deterministically with the cancelId", async () => {
    const rig = makeRig();
    const handle = attachAgent(rig, "agent_b3");
    const cause = rig.scheduler.cancelAgent(handle.agentId);

    await expect(handle.execute(() => "work")).rejects.toThrow(
      new RegExp(`cancelId: ${cause.cancelId}`),
    );
  });

  it("B4: ordinary state changes (admit, wait, succeed) never abort the signal", async () => {
    const rig = makeRig();
    const handle = attachAgent(rig, "agent_b4");

    rig.scheduler.ready(handle.agentId);
    rig.scheduler.admit();
    rig.scheduler.wait(handle.agentId, { kind: "tool", toolName: "deterministic.analyze" });
    rig.scheduler.wake(handle.agentId);
    rig.scheduler.admit();
    rig.scheduler.succeedAgent(handle.agentId);
    await rig.bridge.flush();

    expect(handle.signal.aborted).toBe(false);
    expect(handle.cancellation()).toEqual({ cancelled: false });
  });
});
