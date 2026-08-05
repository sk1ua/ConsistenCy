import { randomUUID } from "node:crypto";
import type {
  HeartbeatConfig,
  HeartbeatPulse,
  HeartbeatState,
  HeartbeatStreamEvent,
  RepoRef,
  ReviewReport
} from "@consistency/schema";
import type { LocalGitAdapter } from "@consistency/vcs-core";
import { computeHealthMetrics, summariseReviewHistory, type ChurnStats } from "./metrics";

/** The slice of `LocalGitAdapter` the daemon actually needs. */
export type HeartbeatRepositorySource = Pick<
  LocalGitAdapter,
  "getRepoRef" | "getWorkingDiff" | "getUntrackedFiles" | "getChurnStats" | "getFileTreeAtCommit"
>;

export type HeartbeatDependencies = {
  repository: HeartbeatRepositorySource;
  config: HeartbeatConfig;
  /** Reports for this repository, newest first. */
  recentReports: () => readonly ReviewReport[];
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export type HeartbeatSubscriber = (event: HeartbeatStreamEvent) => void;

const METRICS_WINDOW_DAYS = 14;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown heartbeat failure";
}

/**
 * Background repository monitor.
 *
 * Polls rather than watching the filesystem: at a 30s cadence a `git diff`
 * against `GIT_OPTIONAL_LOCKS=0` costs little, and it avoids adding a native
 * file-watching dependency to a tool whose own subject is supply-chain risk.
 * A watcher can be layered on later by calling `pulse()` from its events.
 *
 * The daemon never writes to the repository and never enqueues reviews on its
 * own; it observes and publishes, leaving action to the caller.
 */
export class HeartbeatDaemon {
  private state: HeartbeatState = "stopped";
  private timer: NodeJS.Timeout | undefined;
  private readonly subscribers = new Set<HeartbeatSubscriber>();
  private lastPulse: HeartbeatPulse | undefined;
  private pulsing = false;
  private repoRefCache: RepoRef | undefined;

  constructor(private readonly dependencies: HeartbeatDependencies) {}

  private get now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  get currentState(): HeartbeatState {
    return this.state;
  }

  latest(): HeartbeatPulse | undefined {
    return this.lastPulse;
  }

  subscribe(subscriber: HeartbeatSubscriber): () => void {
    this.subscribers.add(subscriber);
    // Replay the most recent pulse so a new stream is not blank until the
    // next tick, which can be up to a full interval away.
    if (this.lastPulse !== undefined) {
      this.deliver(subscriber, { event: "pulse", pulse: this.lastPulse });
    }
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private deliver(subscriber: HeartbeatSubscriber, event: HeartbeatStreamEvent): void {
    try {
      subscriber(event);
    } catch (error) {
      // A broken consumer must not stop the daemon or other subscribers.
      this.dependencies.onError?.(error);
    }
  }

  private publish(event: HeartbeatStreamEvent): void {
    for (const subscriber of [...this.subscribers]) this.deliver(subscriber, event);
  }

  start(): void {
    if (this.state !== "stopped") return;
    if (!this.dependencies.config.enabled) return;
    this.state = "idle";
    // unref so a running daemon never holds the process open on its own.
    this.timer = setInterval(() => {
      void this.pulse();
    }, this.dependencies.config.pulseIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.state = "stopped";
  }

  /**
   * Takes one observation. Overlapping calls are dropped rather than queued:
   * on a large repository a scan can outlast the interval, and queueing would
   * compound the delay indefinitely.
   */
  async pulse(): Promise<HeartbeatPulse | undefined> {
    if (this.pulsing || this.state === "stopped") return undefined;
    this.pulsing = true;
    this.state = "scanning";

    try {
      const repository = await this.dependencies.repository.getRepoRef();
      this.repoRefCache = repository;

      const [changed, untracked] = await Promise.all([
        this.dependencies.repository.getWorkingDiff(),
        this.dependencies.repository.getUntrackedFiles()
      ]);

      const churn = await this.readChurn();
      const filesTracked = await this.countTrackedFiles(repository);
      const history = summariseReviewHistory(this.dependencies.recentReports());

      const pulse: HeartbeatPulse = {
        pulseId: `pulse_${randomUUID()}`,
        state: "idle",
        repository,
        observedAt: this.now.toISOString(),
        dirtyFileCount: changed.length + untracked.length,
        pendingEvents: 0,
        metrics: computeHealthMetrics({
          churn,
          history,
          filesTracked,
          computedAt: this.now
        })
      };
      if (repository.headSha !== undefined) pulse.lastIndexedSha = repository.headSha;

      this.state = "idle";
      this.lastPulse = pulse;
      this.publish({ event: "pulse", pulse });
      return pulse;
    } catch (error) {
      this.state = "degraded";
      const message = errorMessage(error);
      this.dependencies.onError?.(error);

      const degraded: HeartbeatPulse = {
        pulseId: `pulse_${randomUUID()}`,
        state: "degraded",
        repository: this.repoRefCache ?? { root: "unknown", provider: "local_git" },
        observedAt: this.now.toISOString(),
        dirtyFileCount: 0,
        pendingEvents: 0,
        lastError: message
      };
      this.lastPulse = degraded;
      this.publish({ event: "pulse", pulse: degraded });
      this.publish({ event: "error", message, recoverable: true });
      return degraded;
    } finally {
      this.pulsing = false;
    }
  }

  private async readChurn(): Promise<ChurnStats> {
    try {
      return await this.dependencies.repository.getChurnStats(METRICS_WINDOW_DAYS);
    } catch {
      // Churn is a nice-to-have; a shallow clone or empty repo must not
      // degrade the whole pulse.
      return { windowDays: METRICS_WINDOW_DAYS, commits: 0, linesChanged: 0, filesTouched: 0 };
    }
  }

  private async countTrackedFiles(repository: RepoRef): Promise<number> {
    if (repository.headSha === undefined) return 0;
    try {
      const tree = await this.dependencies.repository.getFileTreeAtCommit(repository.headSha);
      return tree.filter(entry => entry.type === "blob").length;
    } catch {
      return 0;
    }
  }
}
