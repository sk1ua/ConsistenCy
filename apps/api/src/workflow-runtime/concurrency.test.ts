/**
 * H18 — bounded, dependency-ready dispatch (concurrency slice).
 *
 * The TS runtime used to await one node at a time. This slice starts an agent
 * as soon as every node it depends on has SETTLED, up to an explicit dispatch
 * width, while keeping the REPORT deterministic (findings, agent summaries and
 * evidence are folded in topological order, never in completion order).
 *
 * Overlap is proven with CONTROLLABLE BARRIERS (Promise gates), never with
 * wall-clock comparisons:
 *   - each model invocation blocks on its own gate, and the gates only open
 *     after the test has OBSERVED every expected call already in flight — a
 *     serial executor can never satisfy that (the first gate would never open,
 *     so the bounded wait below fails fast instead of hanging);
 *   - the dispatch BOUND is proven the same way: with width 2 and three
 *     independent nodes, the third call cannot be entered until a slot frees.
 *
 * Failure propagation and cancellation are also pinned: a failed node stops new
 * dispatch, already-dispatched work is drained (never re-issued), and a run
 * cancellation aborts in-flight provider calls with the single causal id.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RepositorySnapshot } from "@consistency/repository";
import type { TokenUsage, WorkflowRuntimeDefinition } from "@consistency/schema";
import type { TrustedLLMBackend } from "@consistency/workload-review";
import { compileWorkflowRuntimeDefinition } from "./compile";
import {
  executeWorkflowPlan,
  type WorkflowExecutorLlmEntry,
  type WorkflowExecutorStepEvent,
  type WorkflowSnapshotInput,
} from "./executor";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixtureRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-h18-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, "src", "index.ts"),
    [
      "export function wide(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  ",
      `export const token = "ghp_${"F".repeat(36)}";`,
      "export const fine = 1;",
    ].join("\n"),
    "utf8",
  );
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "fixture"]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]) };
}

function analyzerNode(id: string, analyzers: readonly ("style" | "secret")[]) {
  return { id, type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: { analyzers: [...analyzers] }, failurePolicy: "fail-closed" as const };
}
function verifierNode(id: string) {
  return { id, type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", parameters: {}, failurePolicy: "fail-closed" as const };
}
function modelNode(id: string) {
  return { id, type: "verifier.model-structured", serviceRef: "model-structured.verifier", parameters: {}, failurePolicy: "fail-closed" as const };
}

/** analyze → verify → {model-a, model-b, model-c} (three INDEPENDENT verifiers). */
function fanOutDefinition(): WorkflowRuntimeDefinition {
  return {
    id: "h18-fan-out",
    version: 1,
    nodes: [analyzerNode("analyze", ["style", "secret"]), verifierNode("verify"), modelNode("model-a"), modelNode("model-b"), modelNode("model-c")],
    edges: [
      { from: "analyze", to: "verify" },
      { from: "verify", to: "model-a" },
      { from: "verify", to: "model-b" },
      { from: "verify", to: "model-c" },
    ],
  };
}

/** {analyze-a, analyze-b} → verify (two independent producers, one fan-in). */
function twoProducersDefinition(): WorkflowRuntimeDefinition {
  return {
    id: "h18-two-producers",
    version: 1,
    nodes: [analyzerNode("analyze-a", ["style"]), analyzerNode("analyze-b", ["secret"]), verifierNode("verify")],
    edges: [
      { from: "analyze-a", to: "verify" },
      { from: "analyze-b", to: "verify" },
    ],
  };
}

function planFor(definition: WorkflowRuntimeDefinition) {
  const compilation = compileWorkflowRuntimeDefinition(definition);
  if (!compilation.ok || !compilation.plan) throw new Error("definition must compile: " + JSON.stringify(compilation.errors));
  return compilation.plan;
}

function snapshotInput(fixture: { repoPath: string; headSha: string }): WorkflowSnapshotInput {
  return {
    repository: "test/fixture-canonical",
    headSha: fixture.headSha,
    paths: ["src/index.ts"],
    snapshot: RepositorySnapshot.create({
      repositoryPath: fixture.repoPath,
      repository: "test/fixture-canonical",
      headSha: fixture.headSha,
      baseSha: fixture.headSha,
    }),
  };
}

interface Gate {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function makeGate(): Gate {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/**
 * Gated model backend: call N blocks on gate N until the test releases it (or
 * the run is aborted). `entered` records the invocation index the moment the
 * call is IN FLIGHT — the barrier fact the overlap assertions read.
 */
function gatedBackend(options: { readonly gateCount: number }): {
  readonly entry: WorkflowExecutorLlmEntry;
  readonly entered: number[];
  readonly gates: Gate[];
  readonly abortedCalls: number[];
  readonly calls: { count: number };
} {
  const gates = Array.from({ length: options.gateCount }, () => makeGate());
  const entered: number[] = [];
  const abortedCalls: number[] = [];
  const calls = { count: 0 };
  const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
  const backend = {
    invokeStructured: async (request: { userPrompt: string; signal?: AbortSignal }) => {
      const index = calls.count;
      calls.count += 1;
      entered.push(index);
      const gate = gates[Math.min(index, gates.length - 1)]!;
      const aborted = new Promise<never>((_, reject) => {
        const signal = request.signal;
        if (signal === undefined) return;
        if (signal.aborted) {
          abortedCalls.push(index);
          reject(signal.reason ?? new Error("aborted before dispatch"));
          return;
        }
        signal.addEventListener("abort", () => {
          abortedCalls.push(index);
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      });
      await Promise.race([gate.promise, aborted]);
      const fingerprints = [...request.userPrompt.matchAll(/"fingerprint":"([0-9a-f]{64})"/g)].map((match) => match[1]!);
      return {
        data: {
          findings: fingerprints.map((fingerprint) => ({ evidenceFingerprint: fingerprint, verdict: "confirmed", note: "模型复核确认该证据成立" })),
          summary: "所有证据均被模型复核确认",
        },
        tokenUsage: usage,
      };
    },
    invokeAgentFindings: async () => ({ findings: [] }),
    invokeText: async () => ({ text: "ok" }),
  } as unknown as TrustedLLMBackend;
  return { entry: { provider: "mock", model: "mock-fixture", backend }, entered, gates, abortedCalls, calls };
}

/**
 * Waits for a barrier condition. The SUCCESS path is driven purely by the gate
 * facts (no timing); the bounded timeout only turns a "never happened" red into
 * a fast, explicit failure instead of a 30s suite timeout.
 */
async function waitForCondition(check: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("barrier not reached: " + description);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("H18 — bounded concurrency: overlap proven with Promise gates", () => {
  it("H18-c1: two independent nodes are genuinely IN FLIGHT at the same time", async () => {
    const fixture = makeFixtureRepo();
    const plan = planFor(fanOutDefinition());
    const model = gatedBackend({ gateCount: 3 });
    const events: WorkflowExecutorStepEvent[] = [];

    const running = executeWorkflowPlan(plan, snapshotInput(fixture), {
      llm: model.entry,
      maxConcurrency: 3,
      onStepEvent: (event) => {
        events.push(event);
      },
    });

    // Barrier: BOTH model calls must already be in flight before either gate
    // opens. A serial executor could never reach two.
    await waitForCondition(() => model.entered.length >= 2, "two model invocations in flight");
    expect(model.entered.slice(0, 2)).toEqual([0, 1]);
    // Neither gate was released, so the only way call #1 could be entered is
    // that call #0 is still in flight: the two nodes genuinely overlap.
    expect(model.calls.count).toBeGreaterThanOrEqual(2);

    model.gates[0]!.resolve();
    model.gates[1]!.resolve();
    await waitForCondition(() => model.entered.length >= 3, "third model invocation after a slot frees");
    model.gates[2]!.resolve();

    const result = await running;
    expect(result.status).toBe("succeeded");
    // Each node dispatched exactly once (dispatch count == invocation count).
    expect(model.calls.count).toBe(
      events.filter((event) => event.eventType === "step_started" && event.stepId.startsWith("model-")).length,
    );
    for (const nodeId of ["model-a", "model-b", "model-c"]) {
      expect(events.filter((event) => event.stepId === nodeId && event.eventType === "step_started").length).toBe(1);
      expect(events.filter((event) => event.stepId === nodeId && event.eventType === "step_succeeded").length).toBe(1);
    }
  });

  it("H18-c2: the dispatch width is a real bound (third node waits for a free slot)", async () => {
    const fixture = makeFixtureRepo();
    const plan = planFor(fanOutDefinition());
    const model = gatedBackend({ gateCount: 3 });

    const running = executeWorkflowPlan(plan, snapshotInput(fixture), { llm: model.entry, maxConcurrency: 2 });

    await waitForCondition(() => model.entered.length === 2, "exactly two model invocations in flight");
    // Bounded: the third independent node must NOT have been dispatched yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(model.entered).toEqual([0, 1]);
    expect(model.calls.count).toBe(2);

    model.gates[0]!.resolve();
    await waitForCondition(() => model.entered.length === 3, "slot reuse dispatches the third node");
    model.gates[1]!.resolve();
    model.gates[2]!.resolve();

    const result = await running;
    expect(result.status).toBe("succeeded");
    expect(model.calls.count).toBe(3);
  });

  it("H18-c3: fan-in is deterministic — the report equals the serial run even with reversed completion", async () => {
    const fixture = makeFixtureRepo();
    const plan = planFor(fanOutDefinition());

    const serialModel = gatedBackend({ gateCount: 3 });
    const serialRun = executeWorkflowPlan(plan, snapshotInput(fixture), { llm: serialModel.entry, maxConcurrency: 1 });
    await waitForCondition(() => serialModel.entered.length === 1, "serial run reaches the first model call");
    serialModel.gates[0]!.resolve();
    await waitForCondition(() => serialModel.entered.length === 2, "serial run reaches the second model call");
    serialModel.gates[1]!.resolve();
    await waitForCondition(() => serialModel.entered.length === 3, "serial run reaches the third model call");
    serialModel.gates[2]!.resolve();
    const serial = await serialRun;
    expect(serial.status).toBe("succeeded");

    // Concurrent run with the SAME facts but the opposite completion order:
    // model-b (topologically second) finishes before model-a.
    const concurrentModel = gatedBackend({ gateCount: 3 });
    const concurrentRun = executeWorkflowPlan(plan, snapshotInput(fixture), { llm: concurrentModel.entry, maxConcurrency: 3 });
    await waitForCondition(() => concurrentModel.entered.length >= 3, "three model invocations in flight");
    concurrentModel.gates[1]!.resolve();
    await waitForCondition(() => concurrentModel.entered.length === 3 && concurrentModel.calls.count === 3, "all three dispatched");
    concurrentModel.gates[2]!.resolve();
    concurrentModel.gates[0]!.resolve();
    const concurrent = await concurrentRun;
    expect(concurrent.status).toBe("succeeded");

    // Same findings (ids, order) and same agent order, even though completion
    // order differed. Evidence ids are per-run random, so linkage is compared
    // through the CONTENT fingerprints each finding points at.
    const fingerprintsOf = (run: { evidence: readonly { id: string; fingerprint: string }[] }, findings: readonly { evidenceIds: readonly string[] }[]) =>
      findings.map((finding) => finding.evidenceIds.map((id) => run.evidence.find((record) => record.id === id)?.fingerprint ?? id));
    expect(concurrent.miniReport.findings.map((finding) => finding.id)).toEqual(serial.miniReport.findings.map((finding) => finding.id));
    expect(fingerprintsOf(concurrent, concurrent.miniReport.findings)).toEqual(fingerprintsOf(serial, serial.miniReport.findings));
    expect(concurrent.miniReport.agents.map((agent) => agent.nodeId)).toEqual(serial.miniReport.agents.map((agent) => agent.nodeId));
    expect(concurrent.miniReport.agents.map((agent) => agent.nodeId)).toEqual(["analyze", "verify", "model-a", "model-b", "model-c"]);
    expect(concurrent.evidence.map((record) => record.fingerprint)).toEqual(serial.evidence.map((record) => record.fingerprint));
    expect(concurrent.miniReport.evidenceCount).toBe(serial.miniReport.evidenceCount);
  });

  it("H18-c4: a failing node stops new dispatch, drains in-flight work, and never re-issues a call", async () => {
    const fixture = makeFixtureRepo();
    const plan = planFor(twoProducersDefinition());
    const events: WorkflowExecutorStepEvent[] = [];
    const admitted: string[] = [];

    const result = await executeWorkflowPlan(plan, snapshotInput(fixture), {
      maxConcurrency: 2,
      onStepEvent: (event) => {
        events.push(event);
      },
      onAgentAdmitted: (info) => {
        admitted.push(info.nodeId);
        // Injected failure: revoke the analyzer's read capability, so its first
        // protected syscall is DENIED and the node body fails closed.
        if (info.nodeId === "analyze-b") info.revoke("repo.read");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("analyze-b");
    // Failure propagation: the dependent fan-in node was never dispatched.
    expect(events.some((event) => event.stepId === "verify")).toBe(false);
    expect(events.some((event) => event.eventType === "step_failed" && event.stepId === "analyze-b")).toBe(true);
    // The healthy peer ran exactly once (no re-dispatch on the failure path).
    expect(events.filter((event) => event.stepId === "analyze-a" && event.eventType === "step_started").length).toBe(1);
    expect(admitted.filter((nodeId) => nodeId === "analyze-a").length).toBe(1);
  });

  it("H18-c5: cancellation aborts in-flight provider calls with the single causal id", async () => {
    const fixture = makeFixtureRepo();
    const plan = planFor(fanOutDefinition());
    const model = gatedBackend({ gateCount: 3 });
    const events: WorkflowExecutorStepEvent[] = [];
    let cancelled = false;

    const result = await executeWorkflowPlan(plan, snapshotInput(fixture), {
      llm: model.entry,
      maxConcurrency: 3,
      onStepEvent: (event) => {
        events.push(event);
      },
      onRunCreated: (info) => {
        if (cancelled) return;
        cancelled = true;
        // Cancel WHILE two model calls are blocked on their gates.
        void waitForCondition(() => model.entered.length >= 2, "two calls in flight before cancelling").then(() => {
          info.scheduler.cancelRun(info.runId);
        });
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("run-cancelled");
    expect(result.error ?? "").toMatch(/cancel_[0-9a-f]+/);
    // Both in-flight calls observed the abort; neither was re-issued (every
    // dispatched node has exactly one step_started fact).
    await waitForCondition(() => model.abortedCalls.length >= 2, "both in-flight calls aborted");
    expect(model.abortedCalls.length).toBeGreaterThanOrEqual(2);
    expect(model.calls.count).toBe(
      events.filter((event) => event.eventType === "step_started" && event.stepId.startsWith("model-")).length,
    );
    // No cancelled in-flight model step is ever reported as succeeded.
    expect(events.some((event) => event.eventType === "step_succeeded" && event.stepId.startsWith("model-"))).toBe(false);
  });

  it("H18-b1: a non-matching condition skips the node and never calls the provider", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-skip",
      version: 1,
      nodes: [
        analyzerNode("analyze", ["style"]),
        modelNode("model-a"),
        {
          ...modelNode("model-b"),
          when: { source: "model-a", path: ["verdictCount"], equals: -1 },
        },
      ],
      edges: [
        { from: "analyze", to: "model-a" },
        { from: "model-a", to: "model-b" },
      ],
    };
    const model = gatedBackend({ gateCount: 1 });
    const events: WorkflowExecutorStepEvent[] = [];
    const running = executeWorkflowPlan(planFor(definition), snapshotInput(fixture), {
      llm: model.entry,
      onStepEvent: (event) => { events.push(event); },
    });
    await waitForCondition(() => model.entered.length === 1, "only the matching model is in flight");
    model.gates[0]!.resolve();
    const result = await running;
    expect(result.status).toBe("succeeded");
    expect(model.calls.count).toBe(1);
    expect(events.some((event) => event.stepId === "model-b" && event.payload?.skipped === true)).toBe(true);
    expect(events.some((event) => event.eventType === "step_started" && event.stepId === "model-b")).toBe(false);
  });

  it("H18-b1a: a condition reading a missing field fails instead of skipping", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-missing-condition",
      version: 1,
      nodes: [
        analyzerNode("analyze", ["style"]),
        modelNode("model-a"),
        { ...modelNode("model-b"), when: { source: "model-a", path: ["missingField"], equals: true } },
      ],
      edges: [{ from: "analyze", to: "model-a" }, { from: "model-a", to: "model-b" }],
    };
    const model = gatedBackend({ gateCount: 1 });
    const running = executeWorkflowPlan(planFor(definition), snapshotInput(fixture), { llm: model.entry });
    await waitForCondition(() => model.calls.count === 1, "condition source entered");
    model.gates[0]!.resolve();
    const result = await running;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("missing output field");
    expect(model.calls.count).toBe(1);
  });

  it("H18-b2: a failed paid invocation stays single-shot even with retry configured", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-retry",
      version: 1,
      nodes: [
        analyzerNode("analyze", ["style"]),
        { ...modelNode("model-a"), retry: { maxAttempts: 2 } },
      ],
      edges: [{ from: "analyze", to: "model-a" }],
    };
    let calls = 0;
    const events: WorkflowExecutorStepEvent[] = [];
    const backend = {
      invokeStructured: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient provider failure");
        return {
          data: { findings: [], summary: "复核完成，无新增确认项" },
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      invokeAgentFindings: async () => ({ findings: [] }),
      invokeText: async () => ({ text: "ok" }),
    } as unknown as TrustedLLMBackend;
    const result = await executeWorkflowPlan(planFor(definition), snapshotInput(fixture), {
      llm: { provider: "mock", model: "mock-fixture", backend },
      onStepEvent: (event) => { events.push(event); },
    });
    expect(result.status).toBe("degraded");
    expect(calls).toBe(1);
    const started = events.filter((event) => event.stepId === "model-a" && event.eventType === "step_started");
    const failed = events.filter((event) => event.stepId === "model-a" && event.eventType === "step_failed");
    const succeeded = events.filter((event) => event.stepId === "model-a" && event.eventType === "step_succeeded");
    expect(started.map((event) => event.attemptNumber)).toEqual([1]);
    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(0);
  });

  it("H18-b2a: a paid result with a failed outcome write is not retried", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-paid-outcome",
      version: 1,
      nodes: [analyzerNode("analyze", ["style"]), { ...modelNode("model-a"), retry: { maxAttempts: 2 } }],
      edges: [{ from: "analyze", to: "model-a" }],
    };
    const model = gatedBackend({ gateCount: 1 });
    const events: WorkflowExecutorStepEvent[] = [];
    const running = executeWorkflowPlan(planFor(definition), snapshotInput(fixture), {
      llm: model.entry,
      onStepEvent: (event) => {
        if (event.stepId === "model-a" && event.eventType === "step_succeeded") throw new Error("outcome write unavailable");
        events.push(event);
      },
    });
    await waitForCondition(() => model.calls.count === 1, "paid invocation started");
    model.gates[0]!.resolve();
    const result = await running;
    expect(result.status).toBe("failed");
    expect(model.calls.count).toBe(1);
    expect(events.filter((event) => event.stepId === "model-a" && event.eventType === "step_started")).toHaveLength(1);
  });

  it("H18-b2b: an ambiguous provider error cannot authorize a second paid call", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-ambiguous-payment",
      version: 1,
      nodes: [analyzerNode("analyze", ["style"]), { ...modelNode("model-a"), retry: { maxAttempts: 2 } }],
      edges: [{ from: "analyze", to: "model-a" }],
    };
    let calls = 0;
    const backend = {
      invokeStructured: async () => { calls += 1; throw new Error("provider timed out after accepting the request"); },
      invokeAgentFindings: async () => ({ findings: [] }),
      invokeText: async () => ({ text: "ok" }),
    } as unknown as TrustedLLMBackend;
    const result = await executeWorkflowPlan(planFor(definition), snapshotInput(fixture), {
      llm: { provider: "mock", model: "mock-fixture", backend },
    });
    expect(calls).toBe(1);
    expect(result.status).not.toBe("succeeded");
  });

  it("H18-b3: an approval wait is persisted by the gate and does not dispatch", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-wait",
      version: 1,
      nodes: [
        analyzerNode("analyze", ["style"]),
        { ...modelNode("model-a"), approval: { ttlSeconds: 60 } },
      ],
      edges: [{ from: "analyze", to: "model-a" }],
    };
    const model = gatedBackend({ gateCount: 1 });
    const result = await executeWorkflowPlan(planFor(definition), snapshotInput(fixture), {
      llm: model.entry,
      gateApproval: async () => "wait",
    });
    expect(result.status).toBe("awaiting_input");
    expect(result.awaitingStepId).toBe("model-a");
    expect(model.calls.count).toBe(0);
  });

  it("H18-b3b: an excluded node never asks for approval", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-conditional-wait", version: 1,
      nodes: [
        analyzerNode("analyze", ["style"]), modelNode("model-a"),
        { ...modelNode("model-b"), approval: { ttlSeconds: 60 },
          when: { source: "model-a", path: ["verdictCount"], equals: -1 } },
      ],
      edges: [{ from: "analyze", to: "model-a" }, { from: "model-a", to: "model-b" }],
    };
    const model = gatedBackend({ gateCount: 1 });
    let approvalRequests = 0;
    const running = executeWorkflowPlan(planFor(definition), snapshotInput(fixture), {
      llm: model.entry,
      gateApproval: async () => { approvalRequests += 1; return "wait"; },
    });
    await waitForCondition(() => model.calls.count === 1, "condition source entered");
    model.gates[0]!.resolve();
    const result = await running;
    expect(result.status).toBe("succeeded");
    expect(approvalRequests).toBe(0);
    expect(model.calls.count).toBe(1);
  });

  it("H18-b3a: an approval-marked node fails closed without a gate", async () => {
    const fixture = makeFixtureRepo();
    const definition: WorkflowRuntimeDefinition = {
      id: "h18-ungated", version: 1,
      nodes: [analyzerNode("analyze", ["style"]), { ...modelNode("model-a"), approval: { ttlSeconds: 60 } }],
      edges: [{ from: "analyze", to: "model-a" }],
    };
    const model = gatedBackend({ gateCount: 1 });
    const result = await executeWorkflowPlan(planFor(definition), snapshotInput(fixture), { llm: model.entry });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("requires an approval gate");
    expect(model.calls.count).toBe(0);
  });
});
