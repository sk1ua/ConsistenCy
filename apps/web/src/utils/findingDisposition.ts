export type FindingClientDisposition = "accepted" | "dismissed";

export const FINDING_DISPOSITION_STORAGE_PREFIX = "consistency.finding-disposition.v1";

export function findingDispositionStorageKey(jobId: string): string {
  return `${FINDING_DISPOSITION_STORAGE_PREFIX}:${jobId}`;
}

export type FindingDispositionMap = Record<string, FindingClientDisposition>;

export function parseFindingDispositionMap(serialized: string | null): FindingDispositionMap {
  if (!serialized) return {};
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: FindingDispositionMap = {};
    for (const [findingId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof findingId !== "string" || findingId.length === 0) continue;
      if (value === "accepted" || value === "dismissed") result[findingId] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function readFindingDispositions(jobId: string, storage?: Storage | null): FindingDispositionMap {
  if (!jobId) return {};
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    if (!store) return {};
    return parseFindingDispositionMap(store.getItem(findingDispositionStorageKey(jobId)));
  } catch {
    return {};
  }
}

export function writeFindingDispositions(
  jobId: string,
  map: FindingDispositionMap,
  storage?: Storage | null
): void {
  if (!jobId) return;
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    if (!store) return;
    const key = findingDispositionStorageKey(jobId);
    if (Object.keys(map).length === 0) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify(map));
  } catch {
    // Private mode / quota — disposition remains session-local via React state.
  }
}

export function setFindingDisposition(
  map: FindingDispositionMap,
  findingId: string,
  disposition: FindingClientDisposition | null
): FindingDispositionMap {
  const next = { ...map };
  if (disposition === null) delete next[findingId];
  else next[findingId] = disposition;
  return next;
}

export function filterFindingsByDisposition<T extends { id: string }>(
  findings: readonly T[],
  dispositions: FindingDispositionMap,
  options: { showDismissed: boolean }
): T[] {
  return findings.filter(finding => {
    const disposition = dispositions[finding.id];
    if (disposition === "dismissed" && !options.showDismissed) return false;
    return true;
  });
}
