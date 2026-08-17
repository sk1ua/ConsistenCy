import {
  heartbeatPulseSchema,
  repositoryEventSchema,
  type HeartbeatPulse,
  type RepositoryEvent,
  type VcsChangedFile
} from "@consistency/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalGitRepositoryProbe,
  RepositorySupervisor,
  repositoryEventDedupeKey,
  type RepositoryObservation,
  type RepositoryProbe,
  type RepositorySupervisorRegistration,
  type RepositorySupervisorSink
} from "./repositorySupervisor";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const WORKFLOW_A = "1".repeat(64);
const WORKFLOW_B = "2".repeat(64);

function changedFile(path: string, text = "next"): VcsChangedFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      content: `-old\n+${text}\n`
    }]
  };
}

function observation(repositoryId: string, options: {
  head?: string;
  files?: VcsChangedFile[];
  untracked?: string[];
} = {}): RepositoryObservation {
  return {
    repository: {
      root: `fixture-${repositoryId}`,
      provider: "local_git",
      branch: "v2",
      headSha: options.head ?? HEAD_A
    },
    changedFiles: options.files ?? [],
    untrackedFiles: options.untracked ?? []
  };
}

function registration(repositoryId: string, overrides: Partial<RepositorySupervisorRegistration> = {}): RepositorySupervisorRegistration {
  return {
    repositoryId,
    root: `fixture-${repositoryId}`,
    workflowDigest: WORKFLOW_A,
    pollIntervalMs: 10_000,
    debounceMs: 100,
    ...overrides
  };
}

function recordingSink(overrides: Partial<RepositorySupervisorSink> = {}) {
  const pulses: Array<{ repositoryId: string; pulse: HeartbeatPulse }> = [];
  const events: RepositoryEvent[] = [];
  const sink: RepositorySupervisorSink = {
    writePulse: async (repositoryId, pulse) => {
      pulses.push({ repositoryId, pulse });
    },
    writeChangeEvent: async event => {
      events.push(event);
    },
    ...overrides
  };
  return { sink, pulses, events };
}

function fixedDependencies(
  probes: ReadonlyMap<string, RepositoryProbe>,
  sink: RepositorySupervisorSink,
  onError?: (failure: { repositoryId: string; phase: string; error: unknown }) => void
) {
  let pulseId = 0;
  return {
    sink,
    createProbe: (item: Readonly<RepositorySupervisorRegistration>) => {
      const probe = probes.get(item.repositoryId);
      if (!probe) throw new Error(`missing probe ${item.repositoryId}`);
      return probe;
    },
    now: () => new Date("2026-08-14T12:00:00.000Z"),
    createPulseId: () => `pulse-${++pulseId}`,
    onError
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalGitRepositoryProbe", () => {
  it("observes repository identity, tracked changes, and untracked files without mutation", async () => {
    const expected = observation("repo-a", {
      files: [changedFile("src/a.ts")],
      untracked: ["src/new.ts"]
    });
    const source = {
      getRepoRef: vi.fn(async () => expected.repository),
      getWorkingDiff: vi.fn(async () => expected.changedFiles),
      getUntrackedFiles: vi.fn(async () => expected.untrackedFiles)
    };

    await expect(new LocalGitRepositoryProbe(source).observe()).resolves.toEqual(expected);
    expect(source.getRepoRef).toHaveBeenCalledOnce();
    expect(source.getWorkingDiff).toHaveBeenCalledOnce();
    expect(source.getUntrackedFiles).toHaveBeenCalledOnce();
  });
});

describe("RepositorySupervisor", () => {
  it("keeps repository state independent when one probe fails", async () => {
    vi.useFakeTimers();
    const errors: Array<{ repositoryId: string; phase: string }> = [];
    const probes = new Map<string, RepositoryProbe>([
      ["repo-bad", { observe: async () => { throw new Error("index.lock is held"); } }],
      ["repo-good", { observe: async () => observation("repo-good") }]
    ]);
    const recorded = recordingSink();
    const supervisor = new RepositorySupervisor(
      [registration("repo-bad"), registration("repo-good")],
      fixedDependencies(probes, recorded.sink, failure => errors.push(failure))
    );

    await supervisor.start();

    expect(supervisor.getState("repo-bad")).toMatchObject({ state: "degraded", pendingChange: false });
    expect(supervisor.getState("repo-good")).toMatchObject({ state: "idle", pendingChange: false });
    expect(recorded.pulses.map(item => [item.repositoryId, item.pulse.state])).toEqual(expect.arrayContaining([
      ["repo-bad", "degraded"],
      ["repo-good", "idle"]
    ]));
    expect(errors).toEqual([{ repositoryId: "repo-bad", phase: "probe", error: expect.any(Error) }]);
    for (const item of recorded.pulses) expect(() => heartbeatPulseSchema.parse(item.pulse)).not.toThrow();
    supervisor.stop();
  });

  it("isolates a repository-specific persistence failure", async () => {
    vi.useFakeTimers();
    const probes = new Map<string, RepositoryProbe>([
      ["repo-bad", { observe: async () => observation("repo-bad") }],
      ["repo-good", { observe: async () => observation("repo-good") }]
    ]);
    const persisted: string[] = [];
    const errors: Array<{ repositoryId: string; phase: string }> = [];
    const sink: RepositorySupervisorSink = {
      writePulse: async repositoryId => {
        if (repositoryId === "repo-bad") throw new Error("pulse database unavailable");
        persisted.push(repositoryId);
      },
      writeChangeEvent: async () => undefined
    };
    const supervisor = new RepositorySupervisor(
      [registration("repo-bad"), registration("repo-good")],
      fixedDependencies(probes, sink, failure => errors.push(failure))
    );

    await supervisor.start();

    expect(supervisor.getState("repo-bad")?.state).toBe("degraded");
    expect(supervisor.getState("repo-good")?.state).toBe("idle");
    expect(persisted).toEqual(["repo-good"]);
    expect(errors.some(failure => failure.repositoryId === "repo-bad" && failure.phase === "pulse_sink")).toBe(true);
    supervisor.stop();
  });

  it("debounces and coalesces rapid working-tree observations into the latest event", async () => {
    vi.useFakeTimers();
    let current = observation("repo-a", { files: [changedFile("src/first.ts")] });
    const probes = new Map<string, RepositoryProbe>([["repo-a", { observe: async () => current }]]);
    const recorded = recordingSink();
    const supervisor = new RepositorySupervisor(
      [registration("repo-a")],
      fixedDependencies(probes, recorded.sink)
    );

    await supervisor.start();
    current = observation("repo-a", {
      files: [changedFile("src/latest.ts", "latest")],
      untracked: ["src/untracked.ts"]
    });
    await supervisor.scan("repo-a");

    await vi.advanceTimersByTimeAsync(99);
    expect(recorded.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]?.changedFiles.map(file => [file.path, file.status])).toEqual([
      ["src/latest.ts", "modified"],
      ["src/untracked.ts", "untracked"]
    ]);
    expect(recorded.events[0]?.metadata).toMatchObject({
      workflowDigest: WORKFLOW_A,
      untrackedFiles: ["src/untracked.ts"]
    });
    expect(() => repositoryEventSchema.parse(recorded.events[0])).not.toThrow();
    supervisor.stop();
  });

  it("emits at most once for the same repository, HEAD, and workflow digest", async () => {
    vi.useFakeTimers();
    let current = observation("repo-a", { files: [changedFile("src/a.ts")] });
    const probes = new Map<string, RepositoryProbe>([["repo-a", { observe: async () => current }]]);
    const recorded = recordingSink();
    const supervisor = new RepositorySupervisor(
      [registration("repo-a")],
      fixedDependencies(probes, recorded.sink)
    );

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(recorded.events).toHaveLength(1);

    current = observation("repo-a", { files: [changedFile("src/second.ts")] });
    await supervisor.scan("repo-a");
    await vi.advanceTimersByTimeAsync(100);
    expect(recorded.events).toHaveLength(1);

    current = observation("repo-a", { head: HEAD_B, files: [changedFile("src/third.ts")] });
    await supervisor.scan("repo-a");
    await vi.advanceTimersByTimeAsync(100);
    expect(recorded.events).toHaveLength(2);
    expect(new Set(recorded.events.map(event => event.dedupeKey)).size).toBe(2);
    supervisor.stop();
  });

  it("uses the complete idempotency tuple", () => {
    const baseline = repositoryEventDedupeKey("repo-a", HEAD_A, WORKFLOW_A);
    expect(repositoryEventDedupeKey("repo-a", HEAD_A, WORKFLOW_A)).toBe(baseline);
    expect(repositoryEventDedupeKey("repo-b", HEAD_A, WORKFLOW_A)).not.toBe(baseline);
    expect(repositoryEventDedupeKey("repo-a", HEAD_B, WORKFLOW_A)).not.toBe(baseline);
    expect(repositoryEventDedupeKey("repo-a", HEAD_A, WORKFLOW_B)).not.toBe(baseline);
  });

  it("starts idempotently and cancels polling and pending debounce work on stop", async () => {
    vi.useFakeTimers();
    const probe = { observe: vi.fn(async () => observation("repo-a", { files: [changedFile("src/a.ts")] })) };
    const recorded = recordingSink();
    const supervisor = new RepositorySupervisor(
      [registration("repo-a", { pollIntervalMs: 1_000, debounceMs: 500 })],
      fixedDependencies(new Map([["repo-a", probe]]), recorded.sink)
    );

    await supervisor.start();
    await supervisor.start();
    expect(probe.observe).toHaveBeenCalledTimes(1);
    expect(supervisor.isRunning).toBe(true);

    supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recorded.events).toHaveLength(0);
    expect(probe.observe).toHaveBeenCalledTimes(1);
    expect(supervisor.getState("repo-a")).toMatchObject({ state: "stopped", pendingChange: false });
    await expect(supervisor.scan("repo-a")).resolves.toBeUndefined();
  });

  it("normalizes registrations and dynamically adds, disables, and removes repositories", async () => {
    vi.useFakeTimers();
    const probeA = vi.fn(async () => observation("repo-a", { files: [changedFile("src/a.ts")] }));
    const probeB = vi.fn(async () => observation("repo-b"));
    const recorded = recordingSink();
    const createProbe = vi.fn((item: Readonly<RepositorySupervisorRegistration>): RepositoryProbe => {
      if (item.repositoryId === "repo-a") return { observe: probeA };
      if (item.repositoryId === "repo-b") return { observe: probeB };
      throw new Error(`unexpected repository ${item.repositoryId}`);
    });
    const supervisor = new RepositorySupervisor(
      [registration(" repo-a ", {
        root: " fixture-repo-a ",
        workflowDigest: ` ${WORKFLOW_A} `,
        pollIntervalMs: 10_000,
        debounceMs: 100
      })],
      { ...fixedDependencies(new Map(), recorded.sink), createProbe }
    );

    await supervisor.start();
    expect(supervisor.getState("repo-a")).toMatchObject({ state: "idle", pendingChange: true });
    expect(probeA).toHaveBeenCalledOnce();

    await supervisor.reconcile([
      registration("repo-a"),
      registration("repo-b", { pollIntervalMs: 250 })
    ]);
    expect(probeA).toHaveBeenCalledOnce();
    expect(probeB).toHaveBeenCalledOnce();
    expect(supervisor.getState("repo-b")?.state).toBe("idle");

    await supervisor.reconcile([
      registration("repo-a", { enabled: false }),
      registration("repo-b", { pollIntervalMs: 250 })
    ]);
    expect(supervisor.getState("repo-a")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recorded.events).toHaveLength(0);
    expect(probeA).toHaveBeenCalledOnce();
    expect(probeB.mock.calls.length).toBeGreaterThan(1);

    await supervisor.reconcile([]);
    const callsAfterRemoval = probeB.mock.calls.length;
    expect(supervisor.getState("repo-b")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probeB).toHaveBeenCalledTimes(callsAfterRemoval);
    supervisor.stop();
  });

  it("restarts changed registrations with their new probe, workflow, interval, and debounce", async () => {
    vi.useFakeTimers();
    const oldProbe = vi.fn(async () => observation("repo-a", { files: [changedFile("src/old.ts")] }));
    const newProbe = vi.fn(async () => observation("repo-a", { files: [changedFile("src/new.ts")] }));
    const recorded = recordingSink();
    const supervisor = new RepositorySupervisor(
      [registration("repo-a", { root: "checkout-old", pollIntervalMs: 1_000, debounceMs: 500 })],
      {
        ...fixedDependencies(new Map(), recorded.sink),
        createProbe: item => ({
          observe: item.root === "checkout-old" ? oldProbe : newProbe
        })
      }
    );

    await supervisor.start();
    expect(oldProbe).toHaveBeenCalledOnce();

    await supervisor.reconcile([
      registration("repo-a", {
        root: "checkout-new",
        workflowDigest: WORKFLOW_B,
        pollIntervalMs: 250,
        debounceMs: 10
      })
    ]);
    expect(newProbe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9);
    expect(recorded.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]?.changedFiles.map(file => file.path)).toEqual(["src/new.ts"]);
    expect(recorded.events[0]?.metadata).toMatchObject({ workflowDigest: WORKFLOW_B });

    await vi.advanceTimersByTimeAsync(240);
    expect(newProbe).toHaveBeenCalledTimes(2);
    expect(oldProbe).toHaveBeenCalledOnce();
    supervisor.stop();
  });

  it("contains probe construction failures during reconciliation to their repository", async () => {
    vi.useFakeTimers();
    const errors: Array<{ repositoryId: string; phase: string }> = [];
    const goodProbe = vi.fn(async () => observation("repo-good"));
    const recorded = recordingSink();
    const supervisor = new RepositorySupervisor([], {
      ...fixedDependencies(new Map(), recorded.sink, failure => errors.push(failure)),
      createProbe: item => {
        if (item.repositoryId === "repo-bad") throw new Error("checkout disappeared");
        return { observe: goodProbe };
      }
    });
    await supervisor.start();

    await expect(supervisor.reconcile([
      registration("repo-bad"),
      registration("repo-good")
    ])).resolves.toBeUndefined();

    expect(supervisor.getState("repo-bad")?.state).toBe("degraded");
    expect(supervisor.getState("repo-good")?.state).toBe("idle");
    expect(goodProbe).toHaveBeenCalledOnce();
    expect(errors).toEqual([{ repositoryId: "repo-bad", phase: "probe", error: expect.any(Error) }]);
    supervisor.stop();
  });

  it("rejects an invalid reconciliation batch without changing live registrations", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => observation("repo-a"));
    const recorded = recordingSink();
    const createProbe = vi.fn((): RepositoryProbe => ({ observe: probe }));
    const supervisor = new RepositorySupervisor(
      [registration("repo-a")],
      { ...fixedDependencies(new Map(), recorded.sink), createProbe }
    );
    await supervisor.start();

    await expect(supervisor.reconcile([
      registration("repo-b"),
      registration("repo-invalid", { workflowDigest: "not-a-digest" })
    ])).rejects.toThrow("lowercase SHA-256 workflowDigest");
    expect(supervisor.getState("repo-a")?.state).toBe("idle");
    expect(supervisor.getState("repo-b")).toBeUndefined();
    expect(createProbe).toHaveBeenCalledTimes(1);
    supervisor.stop();
  });

  it("rejects duplicate repository registrations before any probe starts", () => {
    const recorded = recordingSink();
    expect(() => new RepositorySupervisor(
      [registration("repo-a"), registration("repo-a")],
      fixedDependencies(new Map([["repo-a", { observe: async () => observation("repo-a") }]]), recorded.sink)
    )).toThrow("registered more than once");
  });
});
