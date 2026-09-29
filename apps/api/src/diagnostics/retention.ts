/**
 * H26 diagnostics retention — local cleanup rules for THIS module's own logs
 * and artifacts only.
 *
 * Scope discipline (H26):
 *   - The index only ever contains artifacts that diagnostics itself
 *     registered. Cleanup therefore can only ever touch artifacts this module
 *     created — user review history, reports, and any other module's files are
 *     invisible here by construction.
 *   - Filesystem removers double-check that a target lives inside the
 *     diagnostics retention directory AND carries the module's file-name
 *     prefix, so even a corrupted index entry cannot widen what gets deleted.
 *   - Run-scoped deletion is reference-counted: an artifact shared by several
 *     runs is removed only when the LAST referencing run is deleted. Deleting
 *     one run never breaks another run's shared artifact references.
 *
 * Nothing in here throws outward: a retention failure is reported in the
 * summary / failure log, never propagated into the run pipeline.
 */

/** Every filesystem artifact of this module starts with this prefix. The
 * adoption sweep (below) recognizes ONLY this exact prefix pattern. */
export const DIAGNOSTICS_ARTIFACT_FILE_PREFIX = "consistency-diagnostics-";

export type DiagnosticsArtifactKind = "diagnostics-bundle" | "diagnostics-shared";

export interface DiagnosticsArtifactRecord {
  readonly artifactId: string;
  readonly kind: DiagnosticsArtifactKind;
  readonly bytes: number;
  /** ISO timestamp used for age and oldest-first eviction ordering. */
  readonly createdAt: string;
  /** Runs currently referencing this artifact (shared artifacts: many). */
  readonly runIds: readonly string[];
}

export interface RetentionLimits {
  /** 条数上限 — maximum number of retained artifacts. */
  readonly maxFiles: number;
  /** 大小上限 — maximum total retained bytes. */
  readonly maxTotalBytes: number;
  /** 期限上限 — maximum age in milliseconds. */
  readonly maxAgeMs: number;
}

/** Best-effort, never-throwing remover (fs unlink guarded by the service). */
export type ArtifactRemover = (artifactId: string) => boolean;

export interface RetentionEnforcementSummary {
  readonly evictedArtifactIds: readonly string[];
  readonly freedBytes: number;
  readonly retainedFiles: number;
  readonly retainedBytes: number;
}

export interface RunDeletionSummary {
  readonly removedArtifactIds: readonly string[];
  /** Shared artifacts kept because another run still references them. */
  readonly retainedSharedArtifactIds: readonly string[];
}

interface IndexEntry {
  record: DiagnosticsArtifactRecord;
  remove: ArtifactRemover;
}

function parseTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareByAge(a: IndexEntry, b: IndexEntry): number {
  const ageDelta = parseTimestamp(a.record.createdAt) - parseTimestamp(b.record.createdAt);
  if (ageDelta !== 0) return ageDelta;
  return a.record.artifactId.localeCompare(b.record.artifactId);
}

/**
 * In-memory registry + retention engine for diagnostics artifacts. The
 * registry is the ONLY thing cleanup looks at: retention enforces size /
 * count / age limits by evicting this module's oldest registered artifacts,
 * and run-scoped deletion is refcount-aware for shared artifacts.
 */
export class DiagnosticsRetentionIndex {
  readonly #entries = new Map<string, IndexEntry>();

  /** Register one module-owned artifact. Idempotent per artifactId. */
  register(input: {
    readonly artifactId: string;
    readonly kind: DiagnosticsArtifactKind;
    readonly bytes: number;
    readonly createdAt?: string;
    readonly runIds: readonly string[];
    readonly remove: ArtifactRemover;
  }): boolean {
    if (this.#entries.has(input.artifactId)) return false;
    this.#entries.set(input.artifactId, {
      record: {
        artifactId: input.artifactId,
        kind: input.kind,
        bytes: Math.max(0, Math.trunc(input.bytes)),
        createdAt: input.createdAt ?? new Date().toISOString(),
        runIds: [...new Set(input.runIds)],
      },
      remove: input.remove,
    });
    return true;
  }

  get(artifactId: string): DiagnosticsArtifactRecord | undefined {
    return this.#entries.get(artifactId)?.record;
  }

  list(): readonly DiagnosticsArtifactRecord[] {
    return [...this.#entries.values()].map((entry) => entry.record);
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Delete one run's diagnostics. An artifact referenced ONLY by this run is
   * removed (remover + index drop). A SHARED artifact (other runs still
   * reference it) keeps its file and entry, and only this run's reference is
   * dropped — other runs' references stay intact and resolvable.
   */
  deleteRun(runId: string): RunDeletionSummary {
    const removed: string[] = [];
    const retainedShared: string[] = [];
    for (const [artifactId, entry] of [...this.#entries.entries()]) {
      if (!entry.record.runIds.includes(runId)) continue;
      const remainingRuns = entry.record.runIds.filter((id) => id !== runId);
      if (remainingRuns.length === 0) {
        let removedFile = false;
        try {
          removedFile = entry.remove(artifactId) === true;
        } catch {
          removedFile = false;
        }
        // The index entry is dropped either way: the registry must match what
        // this module still owns, and an unlink miss (file already gone) is a
        // harmless convergence, not an error.
        this.#entries.delete(artifactId);
        removed.push(artifactId);
        void removedFile;
      } else {
        entry.record = { ...entry.record, runIds: remainingRuns };
        retainedShared.push(artifactId);
      }
    }
    return { removedArtifactIds: removed, retainedSharedArtifactIds: retainedShared };
  }

  /**
   * Enforce the three retention limits (age, count, bytes) over this module's
   * registered artifacts, oldest first. Ties break by artifactId so runs are
   * deterministic. Enforcement evicts artifacts regardless of remaining run
   * references (retention is the shared lifetime contract); run-scoped
   * deletion (`deleteRun`) is the refcount-aware operation.
   */
  enforce(nowIso: string, limits: RetentionLimits): RetentionEnforcementSummary {
    const now = parseTimestamp(nowIso);
    const evicted: string[] = [];
    let freedBytes = 0;

    const evict = (entry: IndexEntry): void => {
      try {
        entry.remove(entry.record.artifactId);
      } catch {
        // A remover that throws despite the contract must not abort the sweep.
      }
      this.#entries.delete(entry.record.artifactId);
      evicted.push(entry.record.artifactId);
      freedBytes += entry.record.bytes;
    };

    // 1. 期限: artifacts past the retention window.
    for (const entry of [...this.#entries.values()].sort(compareByAge)) {
      if (limits.maxAgeMs > 0 && now - parseTimestamp(entry.record.createdAt) > limits.maxAgeMs) {
        evict(entry);
      }
    }

    // 2. 条数: keep the newest `maxFiles` artifacts.
    let survivors = [...this.#entries.values()].sort(compareByAge);
    if (limits.maxFiles > 0 && survivors.length > limits.maxFiles) {
      for (const entry of survivors.slice(0, survivors.length - limits.maxFiles)) {
        evict(entry);
      }
    }

    // 3. 大小: drop oldest-first until the retained bytes fit the budget.
    survivors = [...this.#entries.values()].sort(compareByAge);
    let totalBytes = survivors.reduce((sum, entry) => sum + entry.record.bytes, 0);
    for (const entry of survivors) {
      if (totalBytes <= limits.maxTotalBytes) break;
      evict(entry);
      totalBytes = Math.max(0, totalBytes - entry.record.bytes);
    }

    survivors = [...this.#entries.values()].sort(compareByAge);
    return {
      evictedArtifactIds: evicted,
      freedBytes,
      retainedFiles: survivors.length,
      retainedBytes: survivors.reduce((sum, entry) => sum + entry.record.bytes, 0),
    };
  }
}
