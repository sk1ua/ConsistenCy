/**
 * KernelScheduler tests — AC-SCHED-1 … AC-SCHED-15.
 *
 * The scheduler is admission control + cooperative scheduling: no
 * preemption, explicit yield/wake, priority with deterministic FIFO
 * fairness, concurrency admission, deadline enforcement, Run/Agent
 * cancellation, frozen snapshots, and typed lifecycle events.
 *
 * AC-SCHED-14 uses the REAL CapabilityBroker/SyscallGateway path to prove
 * that ACB capability metadata is never authorization.
 * AC-SCHED-15 proves the Kernel has zero Cordis dependency.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentStateTransitionError,
  CapabilityBroker,
  CapabilityError,
  KernelScheduler,
  MemoryJournal,
  SyscallGateway,
  asAgentId,
  asCapabilityHandle,
  asRunId,
  auditFingerprint,
  makePrincipalId,
  type ASTResource,
  type AgentSnapshot,
  type Principal,
  type SchedulerEvent,
} from "../index.js";

const FIXTURE_START = 1_000_000;

interface Fixture {
  readonly scheduler: KernelScheduler;
  readonly events: SchedulerEvent[];
  setNow(t: number): void;
  advance(ms: number): void;
}

function makeFixture(maxRunningAgents = 1): Fixture {
  let now = FIXTURE_START;
  const scheduler = new KernelScheduler({ maxRunningAgents }, { clock: () => now });
  const events: SchedulerEvent[] = [];
  scheduler.onEvent((event) => events.push(event));
  return {
    scheduler,
    events,
    setNow: (t: number) => {
      now = t;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function withActiveRun(fixture: Fixture, runId = "run-1", runOptions?: { deadline?: number }) {
  fixture.scheduler.registerRun({
    id: asRunId(runId),
    deadline: runOptions?.deadline,
  });
  fixture.scheduler.activateRun(asRunId(runId));
  return asRunId(runId);
}

function registerAgent(
  fixture: Fixture,
  id: string,
  runId = "run-1",
  overrides: Partial<Parameters<KernelScheduler["registerAgent"]>[0]> = {},
): AgentSnapshot {
  return fixture.scheduler.registerAgent({
    id: asAgentId(id),
    runId: asRunId(runId),
    priority: 0,
    executionDomain: "in-process",
    ...overrides,
  });
}

describe("KernelScheduler — AC-SCHED suite", () => {
  it("AC-SCHED-1: a NEW agent cannot execute until READY", () => {
    const fx = makeFixture();
    withActiveRun(fx);
    const agent = registerAgent(fx, "a");

    expect(agent.state).toBe("NEW");
    expect(fx.scheduler.admit()).toBeUndefined();
    expect(fx.scheduler.getAgent(agent.id)!.state).toBe("NEW");

    fx.scheduler.ready(agent.id);
    const admitted = fx.scheduler.admit();
    expect(admitted?.id).toBe(agent.id);
    expect(admitted?.state).toBe("RUNNING");
  });

  it("AC-SCHED-2: READY → RUNNING through scheduler admission, with typed events", () => {
    const fx = makeFixture();
    withActiveRun(fx);
    const agent = registerAgent(fx, "a");
    fx.scheduler.ready(agent.id);

    const admitted = fx.scheduler.admit()!;
    expect(admitted.state).toBe("RUNNING");

    const stateChanges = fx.events.flatMap((e) =>
      e.type === "agent.stateChanged" && e.agentId === agent.id
        ? [{ from: e.from, to: e.to }]
        : [],
    );
    expect(stateChanges).toEqual([{ from: "NEW", to: "READY" }, { from: "READY", to: "RUNNING" }]);
    expect(
      fx.events.some(
        (e) => e.type === "agent.admitted" && e.agentId === agent.id && e.runId === asRunId("run-1"),
      ),
    ).toBe(true);
  });

  it("AC-SCHED-3: max concurrency is enforced and capacity is released on yield", () => {
    const fx = makeFixture(2);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    const b = registerAgent(fx, "b");
    const c = registerAgent(fx, "c");
    fx.scheduler.ready(a.id);
    fx.scheduler.ready(b.id);
    fx.scheduler.ready(c.id);

    expect(fx.scheduler.admit()!.id).toBe(a.id);
    expect(fx.scheduler.admit()!.id).toBe(b.id);
    expect(fx.scheduler.runningCount).toBe(2);
    // Third agent stays queued while capacity is exhausted.
    expect(fx.scheduler.admit()).toBeUndefined();
    expect(fx.scheduler.readyQueueSize).toBe(1);
    expect(fx.scheduler.getAgent(c.id)!.state).toBe("READY");

    // A yields → capacity freed → C may be admitted.
    fx.scheduler.wait(a.id, { kind: "llm", provider: "mock" });
    expect(fx.scheduler.runningCount).toBe(1);
    expect(fx.scheduler.admit()!.id).toBe(c.id);
    expect(fx.scheduler.runningCount).toBe(2);
  });

  it("AC-SCHED-4: higher numeric priority is selected first", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const low = registerAgent(fx, "low", "run-1", { priority: 1 });
    const high = registerAgent(fx, "high", "run-1", { priority: 5 });
    const mid = registerAgent(fx, "mid", "run-1", { priority: 3 });
    // Enqueue in non-priority order to prove priority governs.
    fx.scheduler.ready(low.id);
    fx.scheduler.ready(high.id);
    fx.scheduler.ready(mid.id);

    expect(fx.scheduler.admit()!.id).toBe(high.id);
    expect(fx.scheduler.succeedAgent(high.id).state).toBe("SUCCEEDED");
    expect(fx.scheduler.admit()!.id).toBe(mid.id);
    expect(fx.scheduler.succeedAgent(mid.id).state).toBe("SUCCEEDED");
    expect(fx.scheduler.admit()!.id).toBe(low.id);
  });

  it("AC-SCHED-5: equal-priority agents preserve deterministic FIFO order", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    const b = registerAgent(fx, "b");
    const c = registerAgent(fx, "c");
    fx.scheduler.ready(a.id);
    fx.scheduler.ready(b.id);
    fx.scheduler.ready(c.id);

    expect(fx.scheduler.admit()!.id).toBe(a.id);
    fx.scheduler.succeedAgent(a.id);
    expect(fx.scheduler.admit()!.id).toBe(b.id);
    fx.scheduler.succeedAgent(b.id);
    expect(fx.scheduler.admit()!.id).toBe(c.id);
  });

  it("AC-SCHED-6: RUNNING → WAIT_LLM releases execution capacity and records the pending operation", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    const b = registerAgent(fx, "b");
    fx.scheduler.ready(a.id);
    fx.scheduler.admit();
    fx.scheduler.ready(b.id);

    const waiting = fx.scheduler.wait(a.id, { kind: "llm", provider: "mock" });
    expect(waiting.state).toBe("WAIT_LLM");
    expect(waiting.pendingOperation).toMatchObject({ kind: "llm", provider: "mock" });
    expect(fx.scheduler.runningCount).toBe(0);

    // Capacity was released: B is admitted while A waits on remote inference.
    expect(fx.scheduler.admit()!.id).toBe(b.id);
  });

  it("AC-SCHED-7: WAIT_LLM → READY after wake, pending operation cleared", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    fx.scheduler.ready(a.id);
    fx.scheduler.admit();
    fx.scheduler.wait(a.id, { kind: "tool", toolName: "ast:query" });

    const woken = fx.scheduler.wake(a.id);
    expect(woken.state).toBe("READY");
    expect(woken.pendingOperation).toBeUndefined();
    expect(fx.scheduler.readyQueueSize).toBe(1);

    const admitted = fx.scheduler.admit()!;
    expect(admitted.id).toBe(a.id);
    expect(admitted.state).toBe("RUNNING");
  });

  it("AC-SCHED-8: a terminal agent can never be scheduled again", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    fx.scheduler.ready(a.id);
    fx.scheduler.admit();
    fx.scheduler.succeedAgent(a.id);

    expect(fx.scheduler.getAgent(a.id)!.state).toBe("SUCCEEDED");
    expect(() => fx.scheduler.ready(a.id)).toThrow(AgentStateTransitionError);
    expect(() => fx.scheduler.wake(a.id)).toThrow(AgentStateTransitionError);
    expect(() => fx.scheduler.resumeAgent(a.id)).toThrow(AgentStateTransitionError);
    expect(fx.scheduler.admit()).toBeUndefined();
    expect(fx.scheduler.readyQueueSize).toBe(0);
  });

  it("AC-SCHED-9: invalid state transitions are rejected with typed errors", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");

    expect(() => fx.scheduler.ready(a.id)).not.toThrow();
    expect(() => fx.scheduler.ready(a.id)).toThrow(AgentStateTransitionError); // READY → READY
    expect(() => fx.scheduler.wait(a.id, { kind: "llm" })).toThrow(AgentStateTransitionError); // READY → WAIT_LLM
    expect(() => fx.scheduler.succeedAgent(a.id)).toThrow(AgentStateTransitionError); // READY → SUCCEEDED
    expect(() => fx.scheduler.suspendAgent(a.id)).not.toThrow(); // READY → SUSPENDED
    expect(() => fx.scheduler.resumeAgent(a.id)).not.toThrow(); // SUSPENDED → READY

    fx.scheduler.admit();
    expect(() => fx.scheduler.resumeAgent(a.id)).toThrow(AgentStateTransitionError); // RUNNING → READY
    expect(() => fx.scheduler.wake(a.id)).toThrow(AgentStateTransitionError); // RUNNING → READY
    fx.scheduler.succeedAgent(a.id);
    expect(() => fx.scheduler.cancelAgent(a.id)).toThrow(AgentStateTransitionError); // SUCCEEDED → CANCELLED

    // Cancellation is idempotent on an already-cancelled agent.
    const b = registerAgent(fx, "b");
    fx.scheduler.cancelAgent(b.id);
    expect(() => fx.scheduler.cancelAgent(b.id)).not.toThrow();
    expect(fx.scheduler.getAgent(b.id)!.state).toBe("CANCELLED");
  });

  it("AC-SCHED-10: expired deadlines are never admitted (agent-level and run-level, inclusive boundary)", () => {
    // Agent deadline: now === deadline must NOT run (inclusive expiry).
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a", "run-1", { deadline: FIXTURE_START + 100 });
    fx.scheduler.ready(a.id);
    fx.setNow(FIXTURE_START + 100);
    expect(fx.scheduler.admit()).toBeUndefined();
    const cancelled = fx.scheduler.getAgent(a.id)!;
    expect(cancelled.state).toBe("CANCELLED");
    expect(
      fx.events.some((e) => e.type === "agent.cancelled" && e.agentId === a.id && e.reason === "deadline"),
    ).toBe(true);

    // Run deadline: inherited by agents without their own deadline.
    const fx2 = makeFixture(1);
    withActiveRun(fx2, "run-2", { deadline: FIXTURE_START + 50 });
    const b = registerAgent(fx2, "b", "run-2");
    fx2.scheduler.ready(b.id);
    fx2.setNow(FIXTURE_START + 50);
    expect(fx2.scheduler.admit()).toBeUndefined();
    expect(fx2.scheduler.getAgent(b.id)!.state).toBe("CANCELLED");

    // Before the deadline everything admits normally.
    const fx3 = makeFixture(1);
    withActiveRun(fx3, "run-3", { deadline: FIXTURE_START + 50 });
    const c = registerAgent(fx3, "c", "run-3");
    fx3.scheduler.ready(c.id);
    fx3.setNow(FIXTURE_START + 49);
    expect(fx3.scheduler.admit()!.id).toBe(c.id);
  });

  it("AC-SCHED-11: Run cancellation prevents future admission and cancels all non-terminal agents", () => {
    const fx = makeFixture(2);
    withActiveRun(fx);
    const readyA = registerAgent(fx, "a");
    const runningB = registerAgent(fx, "b");
    const waitingC = registerAgent(fx, "c");
    const newD = registerAgent(fx, "d");
    fx.scheduler.ready(readyA.id);
    fx.scheduler.admit(); // A RUNNING
    fx.scheduler.ready(runningB.id);
    fx.scheduler.admit(); // B RUNNING
    fx.scheduler.wait(runningB.id, { kind: "human", prompt: "approve?" });

    fx.scheduler.cancelRun(asRunId("run-1"));

    expect(fx.scheduler.getRun(asRunId("run-1"))!.state).toBe("CANCELLED");
    for (const id of ["a", "b", "c", "d"]) {
      expect(fx.scheduler.getAgent(asAgentId(id))!.state).toBe("CANCELLED");
    }
    expect(fx.scheduler.readyQueueSize).toBe(0);
    expect(fx.scheduler.runningCount).toBe(0);
    expect(fx.scheduler.admit()).toBeUndefined();

    // Future registrations into the cancelled run are rejected.
    expect(() => registerAgent(fx, "late")).toThrow(/terminal Run/);
    // Cancelled agents can no longer be made ready.
    expect(() => fx.scheduler.ready(readyA.id)).toThrow(AgentStateTransitionError);

    // Run cancellation is idempotent; cancelling a succeeded run is invalid.
    expect(() => fx.scheduler.cancelRun(asRunId("run-1"))).not.toThrow();

    // Scheduler emitted run.cancelled and per-agent cancellations.
    expect(fx.events.some((e) => e.type === "run.cancelled" && e.runId === asRunId("run-1"))).toBe(true);
    expect(
      fx.events.filter((e) => e.type === "agent.cancelled" && e.reason === "run_cancelled"),
    ).toHaveLength(4);
  });

  it("AC-SCHED-12: parent/child cross-Run relationship is rejected at registration", () => {
    const fx = makeFixture(1);
    withActiveRun(fx, "run-1");
    withActiveRun(fx, "run-2");
    registerAgent(fx, "parent", "run-1");

    expect(() =>
      registerAgent(fx, "child", "run-2", { parent: asAgentId("parent") }),
    ).toThrow(/different run/);
  });

  it("AC-SCHED-13: self-parent is rejected; cycles cannot be constructed", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    registerAgent(fx, "a");
    registerAgent(fx, "b", "run-1", { parent: asAgentId("a") });

    expect(() =>
      registerAgent(fx, "self", "run-1", { parent: asAgentId("self") }),
    ).toThrow(/own parent/);

    // Parents are immutable after registration and duplicates are rejected,
    // so a cycle can never be formed.
    expect(() => registerAgent(fx, "a")).toThrow(/already exists/);
    const b = fx.scheduler.getAgent(asAgentId("b"))!;
    expect(b.parent).toBe(asAgentId("a"));
  });

  it("AC-SCHED-14: ACB capability metadata does NOT authorize syscalls (real Kernel path)", async () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const gateway = new SyscallGateway(broker);
    const principal: Principal = {
      id: makePrincipalId("agent", "acb-test", "run-1"),
      kind: "agent",
      runId: "run-1",
    };
    const kernelPrincipal: Principal = {
      id: makePrincipalId("kernel", "core"),
      kind: "kernel",
    };
    const resource: ASTResource = { kind: "ast", snapshotId: "snapshot-test-1" };

    // Issue a real capability and record ONLY its descriptor on the ACB.
    const handle = broker.issue({ subject: principal, action: "ast.query", resource });

    const fx = makeFixture(1);
    withActiveRun(fx);
    const agent = registerAgent(fx, "a", "run-1", {
      capabilities: [
        { handleFingerprint: auditFingerprint(handle), action: "ast.query", resourceKind: "ast" },
      ],
    });

    // The ACB still lists the descriptor after revocation…
    broker.revoke(handle, kernelPrincipal.id);
    expect(fx.scheduler.getAgent(agent.id)!.capabilities).toHaveLength(1);

    // …but the real syscall path is DENIED regardless of ACB metadata.
    let handlerInvoked = false;
    await expect(
      gateway.invoke(
        { principal, handle, action: "ast.query", resource },
        () => {
          handlerInvoked = true;
          return { value: "should never run" };
        },
      ),
    ).rejects.toMatchObject({ name: "CapabilityError", reason: "revoked" } satisfies Partial<CapabilityError>);
    expect(handlerInvoked).toBe(false);

    // A fabricated descriptor for a never-issued capability also grants
    // nothing: an unknown handle is denied by the Broker.
    const unknownHandle = asCapabilityHandle(`cap_${"0".repeat(64)}`);
    await expect(
      gateway.invoke(
        {
          principal,
          handle: unknownHandle,
          action: "ast.query",
          resource,
        },
        () => ({ value: "never" }),
      ),
    ).rejects.toMatchObject({ reason: "unknown_capability" });
  });

  it("AC-SCHED-15: the Kernel has zero Cordis dependency", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const kernelRoot = path.resolve(here, "../..");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(kernelRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };

    expect(pkg.dependencies ?? {}).not.toHaveProperty("cordis");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("cordis");

    const srcRoot = path.join(kernelRoot, "src");
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue; // test sources legitimately mention "cordis"
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    })(srcRoot);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, `cordis import found in ${path.relative(kernelRoot, file)}`).not.toMatch(
        /(?:from\s+|require\s*\()\s*["']cordis/,
      );
    }
  });

  it("red-team: duplicate queue entries are impossible", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    fx.scheduler.ready(a.id);
    expect(fx.scheduler.readyQueueSize).toBe(1);
    expect(() => fx.scheduler.ready(a.id)).toThrow(AgentStateTransitionError); // READY → READY
    expect(fx.scheduler.readyQueueSize).toBe(1);

    fx.scheduler.admit();
    fx.scheduler.wait(a.id, { kind: "io", description: "read" });
    fx.scheduler.wake(a.id);
    expect(fx.scheduler.readyQueueSize).toBe(1); // wake enqueued exactly once
  });

  it("red-team: a WAIT agent never consumes running capacity", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    fx.scheduler.ready(a.id);
    fx.scheduler.admit();
    fx.scheduler.wait(a.id, { kind: "llm" });
    expect(fx.scheduler.runningCount).toBe(0);
  });

  it("red-team: scheduler snapshots are frozen and immutable", () => {
    const fx = makeFixture(1);
    withActiveRun(fx);
    const a = registerAgent(fx, "a");
    fx.scheduler.ready(a.id);
    fx.scheduler.admit();
    fx.scheduler.wait(a.id, { kind: "agent", target: asAgentId("other") });

    const snapshot = fx.scheduler.getAgent(a.id)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pendingOperation)).toBe(true);
    expect(() => {
      (snapshot as { state: string }).state = "READY";
    }).toThrow(TypeError);

    // Internal state unchanged after the rejected mutation.
    expect(fx.scheduler.getAgent(a.id)!.state).toBe("WAIT_AGENT");
  });

  it("red-team: agents in a non-active Run stay queued and never admit", () => {
    const fx = makeFixture(1);
    fx.scheduler.registerRun({ id: asRunId("run-pending") });
    const a = registerAgent(fx, "a", "run-pending");
    fx.scheduler.ready(a.id);

    expect(fx.scheduler.admit()).toBeUndefined();
    expect(fx.scheduler.getAgent(a.id)!.state).toBe("READY");

    fx.scheduler.activateRun(asRunId("run-pending"));
    expect(fx.scheduler.admit()!.id).toBe(a.id);
  });
});
