import { createHash, randomUUID } from "node:crypto";
import {
  WORKING_TREE_REV,
  repositoryEventSchema,
  type HeartbeatPulse,
  type HeartbeatState,
  type RepoRef,
  type RepositoryEvent,
  type VcsChangedFile
} from "@consistency/schema";
import { LocalGitAdapter } from "@consistency/vcs-core";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 750;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type RepositorySupervisorRegistration = {
  repositoryId: string;
  /** Server-only local checkout path. It is never copied into an audit event. */
  root: string;
  workflowDigest: string;
  /** Disabled registrations are removed during reconciliation. Defaults to true. */
  enabled?: boolean;
  pollIntervalMs?: number;
  debounceMs?: number;
};

type NormalizedRepositoryRegistration = Omit<
  RepositorySupervisorRegistration,
  "enabled" | "pollIntervalMs" | "debounceMs"
> & {
  pollIntervalMs: number;
  debounceMs: number;
};

type NormalizedRegistrationCandidate = NormalizedRepositoryRegistration & {
  enabled: boolean;
};

export type RepositoryObservation = {
  repository: RepoRef;
  changedFiles: VcsChangedFile[];
  untrackedFiles: string[];
};

export interface RepositoryProbe {
  observe(): Promise<RepositoryObservation>;
}

export type LocalGitProbeSource = Pick<
  LocalGitAdapter,
  "getRepoRef" | "getWorkingDiff" | "getUntrackedFiles"
>;

/** Read-only probe used by the default factory and directly injectable in tests. */
export class LocalGitRepositoryProbe implements RepositoryProbe {
  constructor(private readonly source: LocalGitProbeSource) {}

  async observe(): Promise<RepositoryObservation> {
    const [repository, changedFiles, untrackedFiles] = await Promise.all([
      this.source.getRepoRef(),
      this.source.getWorkingDiff(),
      this.source.getUntrackedFiles()
    ]);
    return { repository, changedFiles, untrackedFiles };
  }
}

export interface RepositorySupervisorSink {
  /** Persist a repository-scoped pulse; implementations may upsert latest state. */
  writePulse(repositoryId: string, pulse: HeartbeatPulse): Promise<void> | void;
  /** Persist an idempotent repository change event. */
  writeChangeEvent(event: RepositoryEvent): Promise<void> | void;
}

export type RepositorySupervisorError = {
  repositoryId: string;
  phase: "probe" | "pulse_sink" | "change_sink";
  error: unknown;
};

export type RepositorySupervisorScheduler = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type RepositorySupervisorDependencies = {
  sink: RepositorySupervisorSink;
  createProbe?: (registration: Readonly<RepositorySupervisorRegistration>) => RepositoryProbe;
  now?: () => Date;
  createPulseId?: () => string;
  scheduler?: RepositorySupervisorScheduler;
  onError?: (failure: RepositorySupervisorError) => void;
};

export type RepositorySupervisorState = {
  repositoryId: string;
  state: HeartbeatState;
  pendingChange: boolean;
  latestPulse?: HeartbeatPulse;
  lastError?: string;
};

type PendingChange = {
  repository: RepoRef;
  changedFiles: VcsChangedFile[];
  untrackedFiles: string[];
  observationDigest: string;
  workflowDigest: string;
  observedHead?: string;
  occurredAt: string;
};

type RepositoryRuntime = {
  registration: NormalizedRepositoryRegistration;
  probe: RepositoryProbe;
  state: HeartbeatState;
  scanLifecycle?: number;
  lastRepository?: RepoRef;
  latestPulse?: HeartbeatPulse;
  lastError?: string;
  lastDirtyFileCount: number;
  lastObservationDigest?: string;
  pendingChange?: PendingChange;
  debounceTimer?: unknown;
  pollTimer?: unknown;
  emittedDedupeKeys: Set<string>;
  emittingDedupeKeys: Set<string>;
};

const defaultScheduler: RepositorySupervisorScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: timer => clearInterval(timer as NodeJS.Timeout),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout)
};

function validateRegistration(input: RepositorySupervisorRegistration): NormalizedRegistrationCandidate {
  const repositoryId = input.repositoryId.trim();
  const root = input.root.trim();
  const workflowDigest = input.workflowDigest.trim();
  if (repositoryId.length === 0) throw new Error("repositoryId must not be empty");
  if (repositoryId.length > 200) throw new Error("repositoryId must not exceed 200 characters");
  if (root.length === 0) throw new Error(`Repository '${repositoryId}' must provide a checkout root`);
  if (!SHA256_PATTERN.test(workflowDigest)) {
    throw new Error(`Repository '${repositoryId}' must provide a lowercase SHA-256 workflowDigest`);
  }
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Repository '${repositoryId}' pollIntervalMs must be a positive integer`);
  }
  if (!Number.isInteger(debounceMs) || debounceMs < 0) {
    throw new Error(`Repository '${repositoryId}' debounceMs must be a non-negative integer`);
  }
  return {
    repositoryId,
    root,
    workflowDigest,
    enabled: input.enabled ?? true,
    pollIntervalMs,
    debounceMs
  };
}

function normalizeRegistrations(
  registrations: readonly RepositorySupervisorRegistration[]
): Map<string, NormalizedRepositoryRegistration> {
  const normalized = new Map<string, NormalizedRepositoryRegistration>();
  const seen = new Set<string>();
  for (const input of registrations) {
    const candidate = validateRegistration(input);
    if (seen.has(candidate.repositoryId)) {
      throw new Error(`Repository '${candidate.repositoryId}' is registered more than once`);
    }
    seen.add(candidate.repositoryId);
    if (!candidate.enabled) continue;
    const { enabled: _enabled, ...registration } = candidate;
    normalized.set(registration.repositoryId, registration);
  }
  return normalized;
}

function registrationsEqual(
  left: Readonly<NormalizedRepositoryRegistration>,
  right: Readonly<NormalizedRepositoryRegistration>
): boolean {
  return left.repositoryId === right.repositoryId
    && left.root === right.root
    && left.workflowDigest === right.workflowDigest
    && left.pollIntervalMs === right.pollIntervalMs
    && left.debounceMs === right.debounceMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown repository supervisor failure";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unrefTimer(timer: unknown): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) return;
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function sortedObservationFiles(changedFiles: readonly VcsChangedFile[], untrackedFiles: readonly string[]): {
  changedFiles: VcsChangedFile[];
  untrackedFiles: string[];
} {
  const tracked = changedFiles.map(file => ({
    ...file,
    hunks: file.hunks.map(hunk => ({ ...hunk }))
  })).sort((left, right) =>
    left.path.localeCompare(right.path) || left.status.localeCompare(right.status)
  );
  const trackedPaths = new Set(tracked.map(file => file.path));
  const untracked = [...new Set(untrackedFiles)].sort((left, right) => left.localeCompare(right));
  const syntheticUntracked = untracked
    .filter(path => !trackedPaths.has(path))
    .map<VcsChangedFile>(path => ({
      path,
      status: "untracked",
      additions: 0,
      deletions: 0,
      binary: false,
      hunks: []
    }));
  return { changedFiles: [...tracked, ...syntheticUntracked], untrackedFiles: untracked };
}

/** Stable across retries and process restarts for the requested idempotency tuple. */
export function repositoryEventDedupeKey(repositoryId: string, head: string | undefined, workflowDigest: string): string {
  return `repository-supervisor:${sha256([repositoryId, head ?? "UNBORN", workflowDigest])}`;
}

/**
 * Multi-repository observation coordinator.
 *
 * It only persists pulses and repository change events. It intentionally does
 * not enqueue or execute an audit; an integration layer may decide what an
 * emitted event should trigger.
 */
export class RepositorySupervisor {
  private readonly runtimes = new Map<string, RepositoryRuntime>();
  private readonly scheduler: RepositorySupervisorScheduler;
  private readonly createProbe: (
    registration: Readonly<RepositorySupervisorRegistration>
  ) => RepositoryProbe;
  private running = false;
  private lifecycleVersion = 0;

  constructor(
    registrations: readonly RepositorySupervisorRegistration[],
    private readonly dependencies: RepositorySupervisorDependencies
  ) {
    this.scheduler = dependencies.scheduler ?? defaultScheduler;
    this.createProbe = dependencies.createProbe ?? (registration =>
      new LocalGitRepositoryProbe(new LocalGitAdapter({ root: registration.root }))
    );

    for (const registration of normalizeRegistrations(registrations).values()) {
      this.runtimes.set(registration.repositoryId, this.createRuntime(registration));
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  getState(repositoryId: string): RepositorySupervisorState | undefined {
    const runtime = this.runtimes.get(repositoryId);
    if (!runtime) return undefined;
    const state: RepositorySupervisorState = {
      repositoryId,
      state: runtime.state,
      pendingChange: runtime.pendingChange !== undefined
    };
    if (runtime.latestPulse !== undefined) state.latestPulse = runtime.latestPulse;
    if (runtime.lastError !== undefined) state.lastError = runtime.lastError;
    return state;
  }

  states(): RepositorySupervisorState[] {
    return [...this.runtimes.keys()].map(repositoryId => this.getState(repositoryId)!);
  }

  /**
   * Replaces the desired set of enabled repositories without restarting the
   * supervisor. The full input is validated before any live runtime changes.
   */
  async reconcile(registrations: readonly RepositorySupervisorRegistration[]): Promise<void> {
    const desired = normalizeRegistrations(registrations);
    const changed = new Map<string, RepositoryRuntime>();

    // Construct all replacement runtimes before mutating the live set. Probe
    // factory failures are captured inside their repository runtime.
    for (const [repositoryId, registration] of desired) {
      const current = this.runtimes.get(repositoryId);
      if (current && registrationsEqual(current.registration, registration)) continue;
      changed.set(repositoryId, this.createRuntime(registration, current));
    }

    for (const [repositoryId, runtime] of [...this.runtimes]) {
      if (desired.has(repositoryId) && !changed.has(repositoryId)) continue;
      this.runtimes.delete(repositoryId);
      this.deactivateRuntime(runtime);
    }

    for (const [repositoryId, runtime] of changed) {
      this.runtimes.set(repositoryId, runtime);
    }

    if (!this.running || changed.size === 0) return;
    const lifecycle = this.lifecycleVersion;
    for (const runtime of changed.values()) this.activateRuntime(runtime);
    await Promise.all([...changed.values()].map(runtime => this.scanRuntime(runtime)));
    if (!this.isCurrentLifecycle(lifecycle)) return;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const lifecycle = ++this.lifecycleVersion;

    for (const runtime of this.runtimes.values()) this.activateRuntime(runtime);

    await Promise.all([...this.runtimes.values()].map(runtime => this.scanRuntime(runtime)));
    if (!this.isCurrentLifecycle(lifecycle)) return;
  }

  stop(): void {
    if (!this.running && [...this.runtimes.values()].every(runtime => runtime.state === "stopped")) return;
    this.running = false;
    this.lifecycleVersion += 1;
    for (const runtime of this.runtimes.values()) this.deactivateRuntime(runtime);
  }

  /** Runs one observation for one repository; overlapping scans are dropped. */
  async scan(repositoryId: string): Promise<HeartbeatPulse | undefined> {
    const runtime = this.runtimes.get(repositoryId);
    if (!runtime) throw new Error(`Repository '${repositoryId}' is not supervised`);
    return await this.scanRuntime(runtime);
  }

  private async scanRuntime(runtime: RepositoryRuntime): Promise<HeartbeatPulse | undefined> {
    if (!this.running || runtime.scanLifecycle === this.lifecycleVersion) return undefined;

    const lifecycle = this.lifecycleVersion;
    if (!this.isCurrentRuntime(runtime, lifecycle)) return undefined;
    const repositoryId = runtime.registration.repositoryId;
    runtime.scanLifecycle = lifecycle;
    runtime.state = "scanning";
    let phase: RepositorySupervisorError["phase"] = "probe";
    try {
      const observation = await runtime.probe.observe();
      if (!this.isCurrentRuntime(runtime, lifecycle)) return undefined;
      runtime.lastRepository = observation.repository;
      this.observeWorkingTree(runtime, observation, lifecycle);

      const pulse = this.buildPulse(runtime, observation.repository, "idle");
      runtime.latestPulse = pulse;
      phase = "pulse_sink";
      await this.dependencies.sink.writePulse(repositoryId, pulse);
      if (!this.isCurrentRuntime(runtime, lifecycle)) return undefined;
      runtime.state = "idle";
      runtime.lastError = undefined;
      return pulse;
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, lifecycle)) return undefined;
      return await this.recordFailure(runtime, error, phase, lifecycle);
    } finally {
      if (runtime.scanLifecycle === lifecycle) runtime.scanLifecycle = undefined;
      if (!this.running && lifecycle === this.lifecycleVersion) runtime.state = "stopped";
    }
  }

  private get now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private isCurrentLifecycle(lifecycle: number): boolean {
    return this.running && lifecycle === this.lifecycleVersion;
  }

  private isCurrentRuntime(runtime: RepositoryRuntime, lifecycle: number): boolean {
    return this.isCurrentLifecycle(lifecycle)
      && this.runtimes.get(runtime.registration.repositoryId) === runtime;
  }

  private createRuntime(
    registration: NormalizedRepositoryRegistration,
    previous?: RepositoryRuntime
  ): RepositoryRuntime {
    let probe: RepositoryProbe;
    try {
      probe = this.createProbe(registration);
    } catch (error) {
      // Probe construction is repository-local too. Surface it as a degraded
      // observation after start instead of preventing healthy repos starting.
      probe = { observe: async () => { throw error; } };
    }
    return {
      registration,
      probe,
      state: "stopped",
      lastRepository: previous?.lastRepository,
      latestPulse: previous?.latestPulse,
      lastDirtyFileCount: 0,
      emittedDedupeKeys: new Set(previous?.emittedDedupeKeys),
      emittingDedupeKeys: new Set()
    };
  }

  private activateRuntime(runtime: RepositoryRuntime): void {
    runtime.state = "idle";
    runtime.lastError = undefined;
    runtime.lastDirtyFileCount = 0;
    runtime.pollTimer = this.scheduler.setInterval(() => {
      void this.scanRuntime(runtime);
    }, runtime.registration.pollIntervalMs);
    unrefTimer(runtime.pollTimer);
  }

  private deactivateRuntime(runtime: RepositoryRuntime): void {
    if (runtime.pollTimer !== undefined) this.scheduler.clearInterval(runtime.pollTimer);
    if (runtime.debounceTimer !== undefined) this.scheduler.clearTimeout(runtime.debounceTimer);
    runtime.pollTimer = undefined;
    runtime.debounceTimer = undefined;
    runtime.pendingChange = undefined;
    runtime.lastObservationDigest = undefined;
    runtime.emittingDedupeKeys.clear();
    runtime.state = "stopped";
  }

  private reportError(repositoryId: string, phase: RepositorySupervisorError["phase"], error: unknown): void {
    try {
      this.dependencies.onError?.({ repositoryId, phase, error });
    } catch {
      // An observer must not compromise supervision of this or another repo.
    }
  }

  private buildPulse(runtime: RepositoryRuntime, repository: RepoRef, state: "idle" | "degraded", lastError?: string): HeartbeatPulse {
    const pulse: HeartbeatPulse = {
      pulseId: this.dependencies.createPulseId?.() ?? `pulse_${randomUUID()}`,
      state,
      repository,
      observedAt: this.now.toISOString(),
      dirtyFileCount: runtime.lastDirtyFileCount,
      pendingEvents: runtime.pendingChange === undefined ? 0 : 1
    };
    if (lastError !== undefined) pulse.lastError = lastError;
    return pulse;
  }

  private observeWorkingTree(runtime: RepositoryRuntime, observation: RepositoryObservation, lifecycle: number): void {
    const normalized = sortedObservationFiles(observation.changedFiles, observation.untrackedFiles);
    runtime.lastDirtyFileCount = normalized.changedFiles.length;
    if (normalized.changedFiles.length === 0) {
      if (runtime.debounceTimer !== undefined) this.scheduler.clearTimeout(runtime.debounceTimer);
      runtime.debounceTimer = undefined;
      runtime.pendingChange = undefined;
      runtime.lastObservationDigest = undefined;
      return;
    }

    const observationDigest = sha256([
      observation.repository.headSha ?? "UNBORN",
      runtime.registration.workflowDigest,
      normalized.changedFiles
    ]);
    if (observationDigest === runtime.lastObservationDigest) return;
    runtime.lastObservationDigest = observationDigest;
    runtime.pendingChange = {
      repository: observation.repository,
      changedFiles: normalized.changedFiles,
      untrackedFiles: normalized.untrackedFiles,
      observationDigest,
      workflowDigest: runtime.registration.workflowDigest,
      observedHead: observation.repository.headSha,
      occurredAt: this.now.toISOString()
    };

    if (runtime.debounceTimer !== undefined) this.scheduler.clearTimeout(runtime.debounceTimer);
    runtime.debounceTimer = this.scheduler.setTimeout(() => {
      runtime.debounceTimer = undefined;
      void this.flushChange(runtime, lifecycle);
    }, runtime.registration.debounceMs);
    unrefTimer(runtime.debounceTimer);
  }

  private async flushChange(runtime: RepositoryRuntime, lifecycle: number): Promise<void> {
    if (!this.isCurrentRuntime(runtime, lifecycle)) return;
    const pending = runtime.pendingChange;
    runtime.pendingChange = undefined;
    if (!pending) return;

    const repositoryId = runtime.registration.repositoryId;
    const dedupeKey = repositoryEventDedupeKey(repositoryId, pending.observedHead, pending.workflowDigest);
    if (runtime.emittedDedupeKeys.has(dedupeKey) || runtime.emittingDedupeKeys.has(dedupeKey)) return;
    runtime.emittingDedupeKeys.add(dedupeKey);

    try {
      const eventInput: RepositoryEvent = {
        id: `repository_event_${sha256(dedupeKey).slice(0, 32)}`,
        repositoryId,
        type: "working_tree",
        source: pending.repository.provider,
        dedupeKey,
        occurredAt: pending.occurredAt,
        headRevision: WORKING_TREE_REV,
        changedFiles: pending.changedFiles,
        metadata: {
          workflowDigest: pending.workflowDigest,
          observationDigest: pending.observationDigest,
          untrackedFiles: pending.untrackedFiles
        }
      };
      if (pending.observedHead !== undefined) eventInput.baseRevision = pending.observedHead;
      const event = repositoryEventSchema.parse(eventInput);
      await this.dependencies.sink.writeChangeEvent(event);
      if (this.isCurrentRuntime(runtime, lifecycle)) runtime.emittedDedupeKeys.add(dedupeKey);
    } catch (error) {
      if (this.isCurrentRuntime(runtime, lifecycle)) {
        await this.recordFailure(runtime, error, "change_sink", lifecycle);
      }
    } finally {
      runtime.emittingDedupeKeys.delete(dedupeKey);
    }
  }

  private async recordFailure(
    runtime: RepositoryRuntime,
    error: unknown,
    phase: RepositorySupervisorError["phase"],
    lifecycle: number
  ): Promise<HeartbeatPulse | undefined> {
    if (!this.isCurrentRuntime(runtime, lifecycle)) return undefined;
    const repositoryId = runtime.registration.repositoryId;
    const message = errorMessage(error);
    runtime.state = "degraded";
    runtime.lastError = message;
    this.reportError(repositoryId, phase, error);

    const degraded = this.buildPulse(
      runtime,
      runtime.lastRepository ?? { root: repositoryId, provider: "local_git" },
      "degraded",
      message
    );
    runtime.latestPulse = degraded;
    try {
      await this.dependencies.sink.writePulse(repositoryId, degraded);
    } catch (sinkError) {
      this.reportError(repositoryId, "pulse_sink", sinkError);
    }
    return degraded;
  }
}
