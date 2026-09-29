/**
 * RuntimeRegistry — Host-side observer and bounded snapshot cache.
 *
 * Tracks currently active Kernel Runs and retains a bounded in-memory buffer of
 * completed `RunRuntimeSnapshot` DTOs.
 *
 * Strict Observability Contracts:
 *   - Live runs compute a fresh, coherent `RunRuntimeSnapshot` with `telemetryStatus = "live"`.
 *   - Completed runs are captured as immutable snapshots with `telemetryStatus = "completed"`.
 *   - Unknown or old runs return `undefined` (or `{ telemetryStatus: "unavailable" }`).
 *   - Bounded retention: historical completed snapshots stay in memory up to a max count.
 *   - NO raw capability handles, NO secrets, NO full page contents.
 */

import type {
  CapabilityBroker,
  ContextImageId,
  ContextManager,
  KernelScheduler,
  RunId,
  SandboxManager,
} from "@consistency/kernel";
import {
  buildRunRuntimeSnapshot,
} from "@consistency/harness-core";
import {
  type RunRuntimeSnapshot,
  type RuntimeRunSummary,
} from "@consistency/schema";

export interface LiveRunRegistration {
  readonly runId: RunId;
  readonly jobId?: string;
  readonly workloadKind: string;
  readonly scheduler: KernelScheduler;
  readonly contextManager?: ContextManager;
  readonly baseContextImageId?: ContextImageId;
  readonly broker?: CapabilityBroker;
  readonly sandboxManager?: SandboxManager;
  readonly agentLabels?: ReadonlyMap<string, string> | Record<string, string>;
  /**
   * Audit P1-07①: cancel this run's workload — stops further agent admission
   * AND aborts the in-flight provider request. When absent, cancellation
   * falls back to `scheduler.cancelRun` (admission-only).
   */
  readonly requestCancel?: () => void;
}

/**
 * H13: how a cancel request reached a run, with ONE causal id shared by the
 * whole cancel chain. `externalOutcome` is deliberately honest:
 *   - "unknown"  — the signal was delivered but the registry CANNOT promise
 *                  the provider call or child process actually stopped (a
 *                  provider may ignore abort; a subprocess may still unwind);
 *   - "settled"  — the run() promise reached a terminal transition
 *                  (`completeRun`), so every in-flight external operation of
 *                  this registration has ended by definition.
 */
export interface RunCancelSignal {
  /** True when a live registration existed and was signalled. */
  readonly signalled: boolean;
  /** Single causal id for this cancel decision (collapsed on re-request). */
  readonly cancelId: string;
  readonly mode: "workload-abort" | "scheduler-only" | "unregistered" | "already-terminal";
  readonly externalOutcome: "unknown" | "settled";
}

let CANCEL_REQUEST_SEQUENCE = 0;

export class RuntimeRegistry {
  readonly #maxCompleted: number;
  readonly #liveRuns = new Map<string, LiveRunRegistration>();
  readonly #completedSnapshots = new Map<string, RunRuntimeSnapshot>();
  readonly #completedQueue: string[] = [];
  /** H13: cancel bookkeeping — the single causal id per job/run decision. */
  readonly #cancelSignals = new Map<string, RunCancelSignal>();

  constructor(maxCompleted = 50) {
    this.#maxCompleted = maxCompleted;
  }

  registerLiveRun(registration: LiveRunRegistration): void {
    this.#liveRuns.set(registration.runId, registration);
    if (registration.jobId) {
      this.#liveRuns.set(`job:${registration.jobId}`, registration);
    }
  }

  /**
   * H13 unified cancel signal: ONE causal id per cancel decision, collapsed
   * on repeated requests (a second cancel never mints a new cause or
   * double-aborts). `externalOutcome` stays "unknown" until the run's own
   * promise settles via completeRun — the registry never promises that a
   * provider or subprocess actually stopped.
   */
  #signalCancel(registration: LiveRunRegistration): RunCancelSignal {
    const existing = this.#cancelSignals.get(registration.runId);
    if (existing) return existing;
    let signal: RunCancelSignal;
    if (registration.requestCancel) {
      registration.requestCancel();
      signal = {
        signalled: true,
        cancelId: `jobcancel_${(++CANCEL_REQUEST_SEQUENCE).toString(16).padStart(8, "0")}`,
        mode: "workload-abort",
        externalOutcome: "unknown",
      };
    } else {
      try {
        registration.scheduler.cancelRun(registration.runId);
        signal = {
          signalled: true,
          cancelId: `jobcancel_${(++CANCEL_REQUEST_SEQUENCE).toString(16).padStart(8, "0")}`,
          mode: "scheduler-only",
          externalOutcome: "unknown",
        };
      } catch {
        // Already terminal — nothing left to signal; record honestly.
        signal = {
          signalled: false,
          cancelId: `jobcancel_${(++CANCEL_REQUEST_SEQUENCE).toString(16).padStart(8, "0")}`,
          mode: "already-terminal",
          externalOutcome: "settled",
        };
      }
    }
    this.#cancelSignals.set(registration.runId, signal);
    // Also index by jobId: completeRun removes the live registration, but the
    // cancel record must stay answerable for the job afterwards.
    if (registration.jobId) {
      this.#cancelSignals.set(`job:${registration.jobId}`, signal);
    }
    return signal;
  }

  /**
   * Audit P1-07① (extended by H13): request cancellation of a job's live run.
   * Returns the causal record; `signalled: false` means no live run matched —
   * the caller then cancels at the queue/store level only.
   */
  requestCancelByJob(jobId: string): RunCancelSignal {
    const live = this.#liveRuns.get(`job:${jobId}`);
    if (!live) {
      const unregistered: RunCancelSignal = {
        signalled: false,
        cancelId: `jobcancel_${(++CANCEL_REQUEST_SEQUENCE).toString(16).padStart(8, "0")}`,
        mode: "unregistered",
        externalOutcome: "unknown",
      };
      return unregistered;
    }
    return this.#signalCancel(live);
  }

  /**
   * H13: the recorded cancel signal for a job's live run, if any. Lets the
   * HTTP cancel path report honestly what happened (and what is still
   * unknown) without re-signalling. Survives completeRun (the record is
   * indexed by the job id too).
   */
  cancelSignalForJob(jobId: string): RunCancelSignal | undefined {
    const live = this.#liveRuns.get(`job:${jobId}`);
    return this.#cancelSignals.get(live ? live.runId : `job:${jobId}`);
  }

  /**
   * Audit P1-07③: shutdown deadline expiry — cancel every live run so their
   * in-flight provider calls abort and the worker loop can unwind. Returns
   * the number of live runs signalled.
   */
  requestCancelAll(): number {
    const seen = new Set<LiveRunRegistration>();
    for (const key of [...this.#liveRuns.keys()]) {
      const live = this.#liveRuns.get(key);
      if (!live || seen.has(live)) continue;
      seen.add(live);
      this.#signalCancel(live);
    }
    return seen.size;
  }

  completeRun(runId: RunId): RunRuntimeSnapshot | undefined {
    const live = this.#liveRuns.get(runId);
    if (!live) {
      return this.#completedSnapshots.get(runId);
    }

    // H13: the run's own promise reached its terminal transition — every
    // in-flight external operation of this registration has ended. A cancel
    // recorded against it is now fully settled (honest, observable).
    const signal = this.#cancelSignals.get(runId);
    if (signal && signal.externalOutcome !== "settled") {
      const settled: RunCancelSignal = { ...signal, externalOutcome: "settled" };
      this.#cancelSignals.set(runId, settled);
      if (live.jobId) {
        this.#cancelSignals.set(`job:${live.jobId}`, settled);
      }
    }
    const snapshot = buildRunRuntimeSnapshot({
      runId: live.runId,
      workloadKind: live.workloadKind,
      jobId: live.jobId,
      scheduler: live.scheduler,
      contextManager: live.contextManager,
      baseContextImageId: live.baseContextImageId,
      broker: live.broker,
      sandboxManager: live.sandboxManager,
      agentLabels: live.agentLabels,
      telemetryStatus: "completed",
    });

    // Remove live registration
    this.#liveRuns.delete(runId);
    if (live.jobId) {
      this.#liveRuns.delete(`job:${live.jobId}`);
    }

    // Save completed snapshot
    this.#completedSnapshots.set(snapshot.runId, snapshot);
    if (snapshot.jobId) {
      this.#completedSnapshots.set(`job:${snapshot.jobId}`, snapshot);
    }
    this.#completedQueue.push(snapshot.runId);

    // Evict oldest completed runs if capacity exceeded
    while (this.#completedQueue.length > this.#maxCompleted) {
      const evictedRunId = this.#completedQueue.shift()!;
      const evictedSnapshot = this.#completedSnapshots.get(evictedRunId);
      this.#completedSnapshots.delete(evictedRunId);
      if (evictedSnapshot?.jobId) {
        this.#completedSnapshots.delete(`job:${evictedSnapshot.jobId}`);
      }
    }

    return snapshot;
  }

  getSnapshot(id: string): RunRuntimeSnapshot | undefined {
    // 1. Check live runs
    const live = this.#liveRuns.get(id) ?? this.#liveRuns.get(`job:${id}`);
    if (live) {
      return buildRunRuntimeSnapshot({
        runId: live.runId,
        workloadKind: live.workloadKind,
        jobId: live.jobId,
        scheduler: live.scheduler,
        contextManager: live.contextManager,
        baseContextImageId: live.baseContextImageId,
        broker: live.broker,
        sandboxManager: live.sandboxManager,
        agentLabels: live.agentLabels,
        telemetryStatus: "live",
      });
    }

    // 2. Check completed snapshots
    return this.#completedSnapshots.get(id) ?? this.#completedSnapshots.get(`job:${id}`);
  }

  listRunSummaries(): readonly RuntimeRunSummary[] {
    const summaries: RuntimeRunSummary[] = [];
    const seenRunIds = new Set<string>();

    // Live runs
    for (const live of this.#liveRuns.values()) {
      if (seenRunIds.has(live.runId)) continue;
      seenRunIds.add(live.runId);
      const snap = buildRunRuntimeSnapshot({
        runId: live.runId,
        workloadKind: live.workloadKind,
        jobId: live.jobId,
        scheduler: live.scheduler,
        telemetryStatus: "live",
      });
      summaries.push({
        runId: snap.runId,
        workloadKind: snap.workloadKind,
        jobId: snap.jobId,
        state: snap.state,
        createdAt: snap.createdAt,
        telemetryStatus: "live",
        agentCounts: snap.agentCounts,
      });
    }

    // Completed runs
    for (const snap of this.#completedSnapshots.values()) {
      if (seenRunIds.has(snap.runId)) continue;
      seenRunIds.add(snap.runId);
      summaries.push({
        runId: snap.runId,
        workloadKind: snap.workloadKind,
        jobId: snap.jobId,
        state: snap.state,
        createdAt: snap.createdAt,
        telemetryStatus: "completed",
        agentCounts: snap.agentCounts,
      });
    }

    // Sort newest first
    summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return summaries;
  }

  /** Clear all live registrations and completed snapshots (for test cleanup). */
  clear(): void {
    this.#liveRuns.clear();
    this.#completedSnapshots.clear();
    this.#completedQueue.length = 0;
  }
}
