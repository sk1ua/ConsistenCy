import { describe, expect, it, vi } from "vitest";
import {
  heartbeatConfigSchema,
  heartbeatStreamEventSchema,
  type HeartbeatStreamEvent,
  type ReviewReport
} from "@consistency/schema";
import { HeartbeatDaemon, type HeartbeatRepositorySource } from "./daemon";

const HEAD = "a".repeat(40);

function repository(overrides: Partial<HeartbeatRepositorySource> = {}): HeartbeatRepositorySource {
  return {
    getRepoRef: async () => ({ root: "D:/repo", provider: "local_git" as const, branch: "v2", headSha: HEAD }),
    getWorkingDiff: async () => ([{
      path: "a.ts", status: "modified" as const, additions: 1, deletions: 1, binary: false, hunks: []
    }]),
    getUntrackedFiles: async () => ["b.ts", "c.ts"],
    getChurnStats: async () => ({ windowDays: 14, commits: 5, linesChanged: 700, filesTouched: 9 }),
    getFileTreeAtCommit: async () => ([
      { path: "a.ts", type: "blob" as const, sha: HEAD },
      { path: "src", type: "tree" as const, sha: HEAD }
    ]),
    ...overrides
  };
}

function daemon(overrides: {
  repository?: HeartbeatRepositorySource;
  reports?: ReviewReport[];
  enabled?: boolean;
  onError?: (error: unknown) => void;
} = {}) {
  return new HeartbeatDaemon({
    repository: overrides.repository ?? repository(),
    config: heartbeatConfigSchema.parse({ enabled: overrides.enabled ?? true }),
    recentReports: () => overrides.reports ?? [],
    now: () => new Date("2026-08-05T12:00:00.000Z"),
    onError: overrides.onError
  });
}

describe("HeartbeatDaemon", () => {
  it("emits a schema-valid pulse describing the working tree", async () => {
    const instance = daemon();
    instance.start();
    const pulse = await instance.pulse();
    instance.stop();

    expect(pulse).toBeDefined();
    expect(() => heartbeatStreamEventSchema.parse({ event: "pulse", pulse })).not.toThrow();
    // One modified file plus two untracked.
    expect(pulse?.dirtyFileCount).toBe(3);
    expect(pulse?.repository.branch).toBe("v2");
    expect(pulse?.lastIndexedSha).toBe(HEAD);
    // Only blobs count as tracked files, not tree entries.
    expect(pulse?.metrics?.filesTracked).toBe(1);
    expect(pulse?.metrics?.churnRate).toBe(50);
  });

  it("does not start when disabled", async () => {
    const instance = daemon({ enabled: false });
    instance.start();
    expect(instance.currentState).toBe("stopped");
    expect(await instance.pulse()).toBeUndefined();
  });

  it("fans out pulses to every subscriber", async () => {
    const instance = daemon();
    const first: HeartbeatStreamEvent[] = [];
    const second: HeartbeatStreamEvent[] = [];
    instance.start();
    instance.subscribe(event => first.push(event));
    instance.subscribe(event => second.push(event));

    await instance.pulse();
    instance.stop();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.event).toBe("pulse");
  });

  it("replays the last pulse to a late subscriber", async () => {
    const instance = daemon();
    instance.start();
    await instance.pulse();

    const received: HeartbeatStreamEvent[] = [];
    instance.subscribe(event => received.push(event));
    instance.stop();

    // Otherwise a new stream stays blank until the next interval elapses.
    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe("pulse");
  });

  it("stops delivering after unsubscribe", async () => {
    const instance = daemon();
    const received: HeartbeatStreamEvent[] = [];
    instance.start();
    const unsubscribe = instance.subscribe(event => received.push(event));
    await instance.pulse();
    unsubscribe();
    await instance.pulse();
    instance.stop();

    expect(received).toHaveLength(1);
    expect(instance.subscriberCount).toBe(0);
  });

  it("reports a degraded pulse with an explanation when git fails", async () => {
    const onError = vi.fn();
    const instance = daemon({
      repository: repository({
        getWorkingDiff: async () => { throw new Error("git index.lock is held"); }
      }),
      onError
    });
    const events: HeartbeatStreamEvent[] = [];
    instance.start();
    instance.subscribe(event => events.push(event));

    const pulse = await instance.pulse();
    instance.stop();

    expect(pulse?.state).toBe("degraded");
    expect(pulse?.lastError).toContain("index.lock");
    expect(() => heartbeatStreamEventSchema.parse({ event: "pulse", pulse })).not.toThrow();
    expect(events.map(event => event.event)).toEqual(["pulse", "error"]);
    expect(onError).toHaveBeenCalled();
  });

  it("survives a missing churn source rather than degrading the whole pulse", async () => {
    const instance = daemon({
      repository: repository({
        getChurnStats: async () => { throw new Error("shallow clone"); }
      })
    });
    instance.start();
    const pulse = await instance.pulse();
    instance.stop();

    expect(pulse?.state).toBe("idle");
    expect(pulse?.metrics?.churnRate).toBe(0);
  });

  it("drops an overlapping pulse instead of queueing it", async () => {
    let inFlight = 0;
    let peak = 0;
    const instance = daemon({
      repository: repository({
        getWorkingDiff: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise(resolve => setTimeout(resolve, 20));
          inFlight -= 1;
          return [];
        }
      })
    });
    instance.start();

    const [first, second] = await Promise.all([instance.pulse(), instance.pulse()]);
    instance.stop();

    expect(peak).toBe(1);
    // The second call returns immediately rather than compounding the backlog.
    expect(first === undefined || second === undefined).toBe(true);
  });

  it("keeps running when a subscriber throws", async () => {
    const onError = vi.fn();
    const instance = daemon({ onError });
    const good: HeartbeatStreamEvent[] = [];
    instance.start();
    instance.subscribe(() => { throw new Error("broken consumer"); });
    instance.subscribe(event => good.push(event));

    const pulse = await instance.pulse();
    instance.stop();

    expect(pulse?.state).toBe("idle");
    expect(good).toHaveLength(1);
    expect(onError).toHaveBeenCalled();
  });

  it("carries review-derived risk into the pulse metrics", async () => {
    const base = {
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      baseSha: "base123",
      headSha: "head456",
      summary: "Summary",
      riskLevel: "medium" as const,
      agentRuns: [],
      createdAt: "2026-08-05T00:00:00.000Z"
    };
    const instance = daemon({
      reports: [
        {
          ...base, jobId: "job-1", score: 40,
          findings: [{
            id: "f1", agent: "Security", title: "SQLi", severity: "critical",
            confidence: "likely", file: "a.ts", evidence: "e", reasoning: "r", recommendation: "fix"
          }]
        },
        { ...base, jobId: "job-2", score: 90, findings: [] }
      ] as ReviewReport[]
    });
    instance.start();
    const pulse = await instance.pulse();
    instance.stop();

    expect(pulse?.metrics?.unsettledSecurityDebt).toBe(1);
    expect(pulse?.metrics?.riskIndex).toBeGreaterThan(0);
  });

  it("stops cleanly and refuses further pulses", async () => {
    const instance = daemon();
    instance.start();
    instance.stop();
    expect(instance.currentState).toBe("stopped");
    expect(await instance.pulse()).toBeUndefined();
  });
});
