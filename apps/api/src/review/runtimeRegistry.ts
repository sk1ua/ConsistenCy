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
}

export class RuntimeRegistry {
  readonly #maxCompleted: number;
  readonly #liveRuns = new Map<string, LiveRunRegistration>();
  readonly #completedSnapshots = new Map<string, RunRuntimeSnapshot>();
  readonly #completedQueue: string[] = [];

  constructor(maxCompleted = 50) {
    this.#maxCompleted = maxCompleted;
  }

  registerLiveRun(registration: LiveRunRegistration): void {
    this.#liveRuns.set(registration.runId, registration);
    if (registration.jobId) {
      this.#liveRuns.set(`job:${registration.jobId}`, registration);
    }
  }

  completeRun(runId: RunId): RunRuntimeSnapshot | undefined {
    const live = this.#liveRuns.get(runId);
    if (!live) {
      return this.#completedSnapshots.get(runId);
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
