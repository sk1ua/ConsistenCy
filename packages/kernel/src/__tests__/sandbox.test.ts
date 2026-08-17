/**
 * Sandbox subsystem tests — AC-SBX-1..18.
 *
 * Every test that needs a running child forks a REAL Windows/Linux Node
 * process through the real `SandboxManager` → `worker-bootstrap.mjs` chain;
 * nothing here is a mock of the process boundary. RPC operations go through
 * the REAL SyscallGateway → CapabilityBroker chain on the trusted parent.
 */

import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker } from "../capability/broker.js";
import { asCapabilityHandle } from "../capability/types.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { SyscallGateway } from "../syscall/authorize.js";
import { makePrincipalId, type Principal } from "../identity/principal.js";
import { asAgentId } from "../agent/types.js";
import { asRunId } from "../run/types.js";
import { SandboxManager } from "../sandbox/manager.js";
import { SandboxLifecycleBus } from "../sandbox/events.js";
import {
  ForbiddenRpcMethodError,
  UnsupportedExecutionDomainError,
} from "../sandbox/errors.js";
import type {
  BoundOperation,
  PluginDescriptor,
  SandboxLaunchOptions,
  SandboxRunResult,
  TrustedOperationHandler,
} from "../sandbox/types.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./sandbox-fixtures/fixture-plugin.mjs", import.meta.url),
);
const RUN_ID = "run_sandbox_test";
const SNAPSHOT_CONTENT = "export const x = 1;\n";

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  readonly journal: MemoryJournal;
  readonly broker: CapabilityBroker;
  readonly gateway: SyscallGateway;
  readonly manager: SandboxManager;
  readonly bus: SandboxLifecycleBus;
  readonly principal: Principal;
  readonly repoHandle: ReturnType<CapabilityBroker["issue"]>;
  readonly evidenceHandle: ReturnType<CapabilityBroker["issue"]>;
  readonly astHandle: ReturnType<CapabilityBroker["issue"]>;
  readonly handlerCalls: Array<{ method: string; params: Record<string, unknown>; value?: unknown }>;
}

const rigs: Rig[] = [];
const launchedSessions: Array<ReturnType<SandboxManager["launch"]>> = [];

afterEach(() => {
  for (const launch of launchedSessions.splice(0)) {
    try {
      launch.session.cancel();
    } catch {
      /* already terminal */
    }
  }
  for (const rig of rigs.splice(0)) {
    rig.manager.terminateAll();
  }
  delete process.env.CONSISTENCY_SANDBOX_TEST_SECRET;
  delete process.env.GH_TOKEN_SYNTHETIC;
  delete process.env.OPENAI_API_KEY_SYNTHETIC;
  delete (globalThis as Record<string, unknown>).__PARENT_MARKER;
  delete (globalThis as Record<string, unknown>).__CHILD_MARKER;
  delete (globalThis as Record<string, unknown>).__INPROCESS_LOADED;
});

function makeRig(principalOverride?: Principal): Rig {
  const journal = new MemoryJournal();
  const broker = new CapabilityBroker(journal);
  const gateway = new SyscallGateway(broker);
  const bus = new SandboxLifecycleBus();
  const manager = new SandboxManager({ events: bus });
  const principal = principalOverride ?? {
    id: makePrincipalId("agent", "plugin-test", RUN_ID),
    kind: "agent",
    runId: RUN_ID,
  };

  const repoHandle = broker.issue({
    subject: principal,
    action: "repo.read",
    resource: { kind: "repository", id: "test/repo" },
  });
  const evidenceHandle = broker.issue({
    subject: principal,
    action: "evidence.read",
    resource: { kind: "evidence", runId: principal.runId ?? RUN_ID },
  });
  const astHandle = broker.issue({
    subject: principal,
    action: "ast.query",
    resource: { kind: "ast", snapshotId: "snap_test" },
  });

  const rig: Rig = {
    journal,
    broker,
    gateway,
    manager,
    bus,
    principal,
    repoHandle,
    evidenceHandle,
    astHandle,
    handlerCalls: [],
  };
  rigs.push(rig);
  return rig;
}

function defaultOperations(rig: Rig): Map<string, TrustedOperationHandler> {
  return new Map<string, TrustedOperationHandler>([
    [
      "repo.read",
      (params) => {
        rig.handlerCalls.push({ method: "repo.read", params });
        const filePath = typeof params.path === "string" ? params.path : undefined;
        const content = filePath === "src/index.ts" ? SNAPSHOT_CONTENT : undefined;
        if (content === undefined) {
          throw new Error(`unknown file: ${String(filePath)}`);
        }
        const value = { path: filePath, content };
        rig.handlerCalls[rig.handlerCalls.length - 1]!.value = value;
        return { value };
      },
    ],
    [
      "evidence.read",
      (params) => {
        rig.handlerCalls.push({ method: "evidence.read", params });
        return { value: { records: ["ev-1"], echo: params } };
      },
    ],
    [
      "ast.query",
      (params) => {
        rig.handlerCalls.push({ method: "ast.query", params });
        return { value: { nodes: 3, query: params.query } };
      },
    ],
  ]);
}

/** repo.read-only operation set (reuses the default handler for counting). */
function repoOnlyOperations(rig: Rig): Map<string, TrustedOperationHandler> {
  const operations = defaultOperations(rig);
  operations.delete("evidence.read");
  operations.delete("ast.query");
  return operations;
}

function repoOnlyCapabilities(rig: Rig): Map<string, BoundOperation> {
  return new Map<string, BoundOperation>([
    ["repo.read", { action: "repo.read", resource: { kind: "repository", id: "test/repo" }, handle: rig.repoHandle }],
  ]);
}

function defaultCapabilities(rig: Rig): Map<string, BoundOperation> {
  return new Map<string, BoundOperation>([
    ["repo.read", { action: "repo.read", resource: { kind: "repository", id: "test/repo" }, handle: rig.repoHandle }],
    ["evidence.read", { action: "evidence.read", resource: { kind: "evidence", runId: rig.principal.runId ?? RUN_ID }, handle: rig.evidenceHandle }],
    ["ast.query", { action: "ast.query", resource: { kind: "ast", snapshotId: "snap_test" }, handle: rig.astHandle }],
  ]);
}

function descriptor(mode: string, overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    id: `plugin-${mode}`,
    version: "1.0.0",
    trust: "untrusted",
    logicalRing: 3,
    executionDomain: "child-process",
    entrypoint: FIXTURE_PATH,
    requestedOperations: ["repo.read"],
    ...overrides,
  };
}

interface LaunchExtra {
  readonly capabilities?: Map<string, BoundOperation>;
  readonly operations?: Map<string, TrustedOperationHandler>;
  readonly timeoutMs?: number;
  readonly captureTranscript?: boolean;
  readonly workerArgs?: readonly string[];
  readonly runId?: string;
  readonly agentId?: string;
  readonly principal?: Principal;
}

function launch(
  rig: Rig,
  mode: string,
  extra: LaunchExtra = {},
): ReturnType<SandboxManager["launch"]> {
  const options: SandboxLaunchOptions = {
    gateway: rig.gateway,
    principal: extra.principal ?? rig.principal,
    runId: extra.runId !== undefined ? asRunId(extra.runId) : asRunId(extra.principal?.runId ?? rig.principal.runId ?? RUN_ID),
    agentId: extra.agentId !== undefined ? asAgentId(extra.agentId) : asAgentId(`agent-plugin-${mode}`),
    capabilities: extra.capabilities ?? defaultCapabilities(rig),
    operations: extra.operations ?? defaultOperations(rig),
    timeoutMs: extra.timeoutMs,
    captureTranscript: extra.captureTranscript,
    workerArgs: [mode, ...(extra.workerArgs ?? [])],
  };
  const created = rig.manager.launch(descriptor(mode), options);
  launchedSessions.push(created);
  return created;
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// AC-SBX-1..18
// ---------------------------------------------------------------------------

describe("Sandbox child-process execution domain", () => {
  it("AC-SBX-1: the untrusted plugin executes in a DIFFERENT PID", async () => {
    const rig = makeRig();
    const { result } = launch(rig, "pid");
    const outcome = await result;
    expect(outcome.state).toBe("succeeded");
    const payload = outcome.result as { pid: number; platform: string; hasIpc: boolean };
    expect(payload.pid).toBeTypeOf("number");
    expect(payload.pid).not.toBe(process.pid);
    expect(payload.hasIpc).toBe(true);
  });

  it("AC-SBX-2: parent-only env secret absent in child; Kernel-mediated access still works", async () => {
    process.env.CONSISTENCY_SANDBOX_TEST_SECRET = "synthetic-parent-only-9f3a2c";
    const rig = makeRig();
    const { result } = launch(rig, "env-secret");
    const outcome = await result;
    expect(outcome.state).toBe("succeeded");
    const payload = outcome.result as {
      secret: string | null;
      credKeys: string[];
      readOk: boolean;
    };
    expect(payload.secret).toBeNull();
    expect(payload.credKeys).toEqual([]);
    expect(payload.readOk).toBe(true); // secret removal did not break Kernel-mediated access
    expect(rig.handlerCalls.some((call) => call.method === "repo.read")).toBe(true);
  });

  it("AC-SBX-3: child repo.read/evidence.read/ast.query use the REAL Kernel authorization chain", async () => {
    const rig = makeRig();
    const read = await launch(rig, "repo-read").result;
    expect(read.state).toBe("succeeded");
    expect((read.result as { ok: boolean; content: string }).content).toBe(SNAPSHOT_CONTENT);
    expect(rig.handlerCalls.filter((call) => call.method === "repo.read")).toHaveLength(1);

    const evidence = await launch(rig, "evidence-read").result;
    expect(evidence.state).toBe("succeeded");
    expect((evidence.result as { ok: boolean }).ok).toBe(true);
    expect(rig.handlerCalls.some((call) => call.method === "evidence.read")).toBe(true);

    const ast = await launch(rig, "ast-query").result;
    expect(ast.state).toBe("succeeded");
    expect((ast.result as { ok: boolean }).ok).toBe(true);
    expect(rig.handlerCalls.some((call) => call.method === "ast.query")).toBe(true);
  }, 20_000);

  it("AC-SBX-4: recognized method without capability → DENY, handler never invoked", async () => {
    const rig = makeRig();
    // The method is REGISTERED (recognized) but its binding references a
    // handle the broker has never issued → unknown_capability DENY.
    const capabilities = new Map<string, BoundOperation>([
      ["repo.read", { action: "repo.read", resource: { kind: "repository", id: "test/repo" }, handle: asCapabilityHandle(`cap_${"1".repeat(64)}`) }],
    ]);
    const { result } = launch(rig, "repo-read", { capabilities, operations: repoOnlyOperations(rig) });
    const outcome = await result;
    expect(outcome.state).toBe("succeeded"); // operation denied, session survives
    const payload = outcome.result as { ok: boolean; code: string; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("denied");
    expect(payload.message).toContain("unknown_capability");
    expect(rig.handlerCalls).toHaveLength(0); // handler never ran

    // Unregistered method → typed DENY, session still alive.
    const unknown = await launch(rig, "unknown-method").result;
    expect(unknown.state).toBe("succeeded");
    const unknownPayload = unknown.result as { code: string; stillAlive: boolean };
    expect(unknownPayload.code).toBe("unknown_method");
    expect(unknownPayload.stillAlive).toBe(true);
    expect(rig.handlerCalls).toHaveLength(0);
  }, 20_000);

  it("AC-SBX-5: revocation with a LIVE child → next RPC DENY without restart", async () => {
    const rig = makeRig();
    let calls = 0;
    let releaseSecond!: () => void;
    let signalSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      signalSecond = resolve;
    });
    const secondRelease = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const operations = new Map<string, TrustedOperationHandler>([
      [
        "repo.read",
        async (params) => {
          calls += 1;
          rig.handlerCalls.push({ method: "repo.read", params });
          if (calls === 2) {
            signalSecond();
            await secondRelease;
          }
          return { value: { content: `content-${calls}` } };
        },
      ],
    ]);
    const capabilities = repoOnlyCapabilities(rig);

    const { result, session } = launch(rig, "revoke-live", { operations, capabilities });
    await waitFor(() => calls === 2);

    // The child is still alive with a pending request — revoke NOW.
    rig.broker.revoke(rig.repoHandle, makePrincipalId("kernel", "admin"));
    releaseSecond();

    const outcome: SandboxRunResult = await result;
    expect(outcome.state).toBe("succeeded");
    const payload = outcome.result as {
      pid: number;
      firstOk: boolean;
      secondOk: boolean;
      third: { ok: boolean; code: string; message: string };
    };
    expect(payload.pid).toBe(session.snapshot().pid); // same process throughout
    expect(payload.firstOk).toBe(true);
    expect(payload.secondOk).toBe(true); // authorized before revocation completed
    expect(payload.third.ok).toBe(false); // denied WITHOUT restart
    expect(payload.third.code).toBe("denied");
    expect(payload.third.message).toContain("revoked");
    expect(calls).toBe(2); // third attempt denied BEFORE the handler ran
    expect(rig.handlerCalls.filter((call) => call.method === "repo.read")).toHaveLength(2);
  }, 20_000);

  it("AC-SBX-6: a sandbox cannot impersonate another Agent/Run/Principal", async () => {
    // 6a: smuggled identity fields in params are IGNORED — the parent
    // authorizes as the SESSION principal (which holds repo.read).
    const rigA = makeRig();
    const smuggle = await launch(rigA, "smuggle-identity").result;
    expect(smuggle.state).toBe("succeeded");
    const smuggled = smuggle.result as { allowed: boolean; code?: string; message?: string };
    expect(smuggled.allowed).toBe(true); // parent used session identity, not the smuggled one
    expect(smuggled.code).toBeUndefined();

    // 6b: session B cannot reuse A's capability handle — subject_mismatch.
    // Same broker as A (so the handle EXISTS), different session principal.
    const principalB: Principal = {
      id: makePrincipalId("agent", "other-plugin", "run_B"),
      kind: "agent",
      runId: "run_B",
    };
    const stolenBinding = new Map<string, BoundOperation>([
      ["repo.read", { action: "repo.read", resource: { kind: "repository", id: "test/repo" }, handle: rigA.repoHandle }],
    ]);
    const callsBeforeB = rigA.handlerCalls.length;
    const stolen = await launch(rigA, "repo-read", {
      capabilities: stolenBinding,
      operations: repoOnlyOperations(rigA),
      principal: principalB,
      runId: "run_B",
      agentId: "agent-other-plugin",
    }).result;
    expect(stolen.state).toBe("succeeded");
    const stolenPayload = stolen.result as { ok: boolean; code: string; message: string };
    expect(stolenPayload.ok).toBe(false);
    expect(stolenPayload.code).toBe("denied");
    expect(stolenPayload.message).toContain("subject_mismatch");
    expect(rigA.handlerCalls).toHaveLength(callsBeforeB); // handler never ran
  }, 20_000);

  it("AC-SBX-7: child crash cannot crash the Kernel process", async () => {
    const rig = makeRig();

    const crashExit = await launch(rig, "crash-exit").result;
    expect(crashExit.state).toBe("failed");
    expect(crashExit.error?.code).toBe("crash");
    expect(rig.manager.get(crashExit.sessionId)?.exitCode).toBe(1);

    const crashThrow = await launch(rig, "crash-throw").result;
    expect(crashThrow.state).toBe("failed");
    expect(crashThrow.error?.code).toBe("plugin_error");

    // The Kernel is untouched: a fresh sandbox still works.
    const after = await launch(rig, "pid").result;
    expect(after.state).toBe("succeeded");
  }, 20_000);

  it("AC-SBX-8: timeout terminates the child, cleans the session, no orphan", async () => {
    const rig = makeRig();
    const events: string[] = [];
    rig.bus.subscribe((event) => events.push(event.type));

    const { result, session } = launch(rig, "hang", { timeoutMs: 700 });
    const outcome = await result;
    expect(outcome.state).toBe("timed_out");
    expect(outcome.error?.code).toBe("timeout");

    await session.exited;
    const snapshot = session.snapshot();
    expect(snapshot.processExited).toBe(true);
    expect(snapshot.terminationReason).toBe("timeout");
    expect(rig.manager.activeSessions()).toHaveLength(0);
    expect(events).toContain("session.launched");
    expect(events).toContain("session.timed_out");

    // No orphan process.
    const pid = snapshot.pid!;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("AC-SBX-9: cancellation invalidates the sandbox and DENIES new RPC", async () => {
    const rig = makeRig();
    const neverResolve = new Map<string, TrustedOperationHandler>([
      ["repo.read", () => new Promise(() => {})],
    ]);
    const { result, session } = launch(rig, "hang-rpc", {
      operations: neverResolve,
      capabilities: repoOnlyCapabilities(rig),
      timeoutMs: 10_000,
    });

    await waitFor(() => session.snapshot().pendingRequestCount === 1);
    expect(rig.manager.cancel(session.id)).toBe(true);

    const outcome = await result;
    expect(outcome.state).toBe("cancelled");
    expect(outcome.error?.code).toBe("cancelled");

    // Cancelling an already-terminal session is a no-op (returns false).
    expect(rig.manager.cancel(session.id)).toBe(false);

    await session.exited;
    expect(session.snapshot().processExited).toBe(true);
    expect(rig.manager.activeSessions()).toHaveLength(0);

    // The fixture observed: pending RPC → "cancelled", NEW RPC → DENIED.
    const diagnostics = session.snapshot().diagnostics;
    expect(diagnostics).toContain('"first":"cancelled"');
    expect(diagnostics).toContain('"second":"session_terminated"');
  }, 20_000);

  it("AC-SBX-10: malformed RPC fails closed (session terminated, Kernel alive)", async () => {
    const rig = makeRig();
    const modes = [
      "malformed-string",
      "malformed-version",
      "malformed-no-requestid",
      "malformed-params",
    ];
    for (const mode of modes) {
      const outcome = await launch(rig, mode, { timeoutMs: 8000 }).result;
      expect(outcome.state).toBe("failed");
      expect(outcome.error?.code).toBe("protocol_violation");
    }

    // Duplicate requestId while the first is still pending → violation.
    const neverResolve = new Map<string, TrustedOperationHandler>([
      ["repo.read", () => new Promise(() => {})],
    ]);
    const dup = await launch(rig, "malformed-duplicate", {
      operations: neverResolve,
      capabilities: repoOnlyCapabilities(rig),
      timeoutMs: 8000,
    }).result;
    expect(dup.state).toBe("failed");
    expect(dup.error?.code).toBe("protocol_violation");
    expect(dup.error?.message).toContain("duplicate_request_id");

    // Request flood beyond the pending cap → violation (no handler storm).
    const flood = await launch(rig, "flood", {
      operations: neverResolve,
      capabilities: repoOnlyCapabilities(rig),
      timeoutMs: 8000,
    }).result;
    expect(flood.state).toBe("failed");
    expect(flood.error?.code).toBe("protocol_violation");
    expect(flood.error?.message).toContain("too_many_pending_requests");

    // Kernel unharmed after six hostile children.
    const after = await launch(rig, "pid").result;
    expect(after.state).toBe("succeeded");
  }, 40_000);

  it("AC-SBX-11: unknown method fails closed without executing anything", async () => {
    const rig = makeRig();
    const outcome = await launch(rig, "unknown-method").result;
    expect(outcome.state).toBe("succeeded");
    const payload = outcome.result as { code: string; stillAlive: boolean };
    expect(payload.code).toBe("unknown_method");
    expect(payload.stillAlive).toBe(true);
    expect(rig.handlerCalls).toHaveLength(0);
  }, 15_000);

  it("AC-SBX-12: oversized message is rejected (session terminated)", async () => {
    const rig = makeRig();
    const outcome = await launch(rig, "oversized", { timeoutMs: 8000 }).result;
    expect(outcome.state).toBe("failed");
    expect(outcome.error?.code).toBe("protocol_violation");
    expect(outcome.error?.message).toContain("oversized");
    expect(rig.handlerCalls).toHaveLength(0);
  }, 15_000);

  it("AC-SBX-13: raw CapabilityHandle is never sent to the child", async () => {
    const rig = makeRig();
    const { result, session } = launch(rig, "repo-read", { captureTranscript: true });
    const outcome = await result;
    expect(outcome.state).toBe("succeeded");

    const transcript = session.transcript();
    const outboundJson = JSON.stringify(transcript.outbound);
    const inboundJson = JSON.stringify(transcript.inbound);
    expect(outboundJson).not.toContain(rig.repoHandle);
    expect(inboundJson).not.toContain(rig.repoHandle);
    expect(outboundJson).not.toContain("cap_");
    expect(JSON.stringify(outcome.result)).not.toContain(rig.repoHandle);
  }, 15_000);

  it("AC-SBX-14: parent credentials absent from protocol traffic and child env", async () => {
    process.env.GH_TOKEN_SYNTHETIC = "ghp_synthetic_parent_token_1234";
    process.env.OPENAI_API_KEY_SYNTHETIC = "sk-synthetic-parent-key-5678";
    const rig = makeRig();

    const { result, session } = launch(rig, "raw-kernel-import", { captureTranscript: true });
    const outcome = await result;
    expect(outcome.state).toBe("succeeded");

    const payload = outcome.result as {
      importResult: unknown;
      leakedValuePatterns: string[];
      envScan: string[];
    };
    expect(payload.envScan).toEqual([]); // no credential-named vars in the child
    // Even if the Kernel package were importable in the child, its string
    // exports must not contain handles or credential-shaped values.
    expect(payload.leakedValuePatterns).toEqual([]);

    const traffic = JSON.stringify({
      inbound: session.transcript().inbound,
      outbound: session.transcript().outbound,
      result: outcome.result,
    });
    expect(traffic).not.toContain("ghp_synthetic_parent_token_1234");
    expect(traffic).not.toContain("sk-synthetic-parent-key-5678");
  }, 15_000);

  it("§40: child process has separate globals and cannot mutate parent memory", async () => {
    (globalThis as Record<string, unknown>).__PARENT_MARKER = "parent-value";
    const rig = makeRig();

    const { result } = launch(rig, "global-memory");
    const outcome = await result;
    expect(outcome.state).toBe("succeeded");
    const payload = outcome.result as {
      parentMarker: string | null;
      childMarker: string;
      tampered: { mutated?: string };
    };
    // The child sees NONE of the parent's globals…
    expect(payload.parentMarker).toBeNull();
    // …and its own global mutation never reaches the parent process.
    expect(payload.childMarker).toBe("child-set");
    expect((globalThis as Record<string, unknown>).__CHILD_MARKER).toBeUndefined();
    expect((globalThis as Record<string, unknown>).__PARENT_MARKER).toBe("parent-value");

    // Mutating the RPC result clone cannot mutate the parent-side object.
    const parentSide = rig.handlerCalls.find((call) => call.method === "repo.read")?.value;
    expect(parentSide).toBeDefined();
    expect(parentSide).not.toHaveProperty("mutated");
    expect(payload.tampered.mutated).toBe("child-tampered");
  }, 15_000);

  it("AC-SBX-15: untrusted plugin NEVER silently falls back to in-process", async () => {
    const rig = makeRig();
    // Domains without a sandbox executor fail closed at the API level.
    expect(() =>
      rig.manager.launch(
        descriptor("x", { executionDomain: "in-process" }),
        {
          gateway: rig.gateway,
          principal: rig.principal,
          capabilities: defaultCapabilities(rig),
          operations: defaultOperations(rig),
        },
      ),
    ).toThrow(UnsupportedExecutionDomainError);
    expect(() =>
      rig.manager.launch(
        descriptor("x", { executionDomain: "worker-thread" }),
        {
          gateway: rig.gateway,
          principal: rig.principal,
          capabilities: defaultCapabilities(rig),
          operations: defaultOperations(rig),
        },
      ),
    ).toThrow(UnsupportedExecutionDomainError);

    // A plugin designed to mark its own in-process load runs in the CHILD:
    // the PARENT global stays clean.
    const marker = await launch(rig, "inproc-marker").result;
    expect(marker.state).toBe("succeeded");
    expect((marker.result as { childSet: boolean }).childSet).toBe(true);
    expect((globalThis as Record<string, unknown>).__INPROCESS_LOADED).toBeUndefined();

    // Launch failure (missing entrypoint) → failed session, no fallback run.
    const missing = rig.manager.launch(
      descriptor("missing", { entrypoint: path.join(os.tmpdir(), "no-such-plugin.mjs") }),
      {
        gateway: rig.gateway,
        principal: rig.principal,
        capabilities: defaultCapabilities(rig),
        operations: defaultOperations(rig),
        timeoutMs: 8000,
      },
    );
    launchedSessions.push(missing);
    const missingOutcome = await missing.result;
    expect(missingOutcome.state).toBe("failed");
    expect(missingOutcome.error?.code).toBe("entrypoint_load_failed");
    expect(rig.manager.activeSessions()).toHaveLength(0);
  }, 20_000);

  it("AC-SBX-16: two sandboxes remain isolated (A succeeds while B is cancelled)", async () => {
    const rigA = makeRig();
    const principalB: Principal = {
      id: makePrincipalId("agent", "other", "run_B"),
      kind: "agent",
      runId: "run_B",
    };
    const rigB = makeRig(principalB);

    const launchA = launch(rigA, "repo-read");
    const launchB = launch(rigB, "hang", { timeoutMs: 10_000 });

    const outcomeA = await launchA.result;
    expect(outcomeA.state).toBe("succeeded");
    expect((outcomeA.result as { content: string }).content).toBe(SNAPSHOT_CONTENT);

    expect(launchA.session.snapshot().pid).not.toBe(launchB.session.snapshot().pid);
    expect(launchA.session.snapshot().principalId).not.toBe(launchB.session.snapshot().principalId);

    // Terminating B must not affect A.
    rigB.manager.cancel(launchB.sessionId);
    const outcomeB = await launchB.result;
    expect(outcomeB.state).toBe("cancelled");
    await launchB.session.exited;

    const snapshotA = launchA.session.snapshot();
    expect(snapshotA.state).toBe("succeeded");
    expect(rigA.manager.get(launchA.sessionId)?.state).toBe("succeeded");
  }, 20_000);

  it("AC-SBX-17: github.publish / repo.write are unavailable through child RPC", async () => {
    const rig = makeRig();
    const outcome = await launch(rig, "commit-actions").result;
    expect(outcome.state).toBe("succeeded");
    const payload = outcome.result as {
      publish: { ok: boolean; code: string };
      write: { ok: boolean; code: string };
    };
    expect(payload.publish.ok).toBe(false);
    expect(payload.publish.code).toBe("unknown_method");
    expect(payload.write.ok).toBe(false);
    expect(payload.write.code).toBe("unknown_method");
    expect(rig.handlerCalls).toHaveLength(0);

    // The manager refuses to even REGISTER a commit action as an RPC method.
    const commitCap = new Map<string, BoundOperation>([
      ["github.publish", { action: "github.publish", resource: { kind: "github.publish", repositoryId: "test/repo" }, handle: rig.repoHandle }],
    ]);
    expect(() =>
      rig.manager.launch(descriptor("x"), {
        gateway: rig.gateway,
        principal: rig.principal,
        capabilities: commitCap,
        operations: new Map([["github.publish", () => ({ value: "x" })]]),
      }),
    ).toThrow(ForbiddenRpcMethodError);
  }, 15_000);

  it("AC-SBX-18: the Kernel sandbox subsystem stays dependency-independent", () => {
    const sandboxRoot = fileURLToPath(new URL("../sandbox", import.meta.url));
    const forbidden = [
      "cordis",
      "octokit",
      "langgraph",
      "tree-sitter",
      "workload-review",
      "@consistency/repository",
      "@consistency/harness-core",
    ];

    const walk = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walk(full));
        else files.push(full);
      }
      return files;
    };

    const files = walk(sandboxRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const banned of forbidden) {
        expect(content, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });
});
