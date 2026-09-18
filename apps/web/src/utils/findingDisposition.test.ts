import { describe, expect, it } from "vitest";
import {
  filterFindingsByDisposition,
  findingDispositionStorageKey,
  parseFindingDispositionMap,
  readFindingDispositions,
  setFindingDisposition,
  writeFindingDispositions
} from "./findingDisposition";

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
}

describe("findingDisposition helper", () => {
  it("parses only accepted/dismissed values", () => {
    expect(parseFindingDispositionMap(JSON.stringify({
      a: "dismissed",
      b: "accepted",
      c: "nope",
      "": "dismissed"
    }))).toEqual({ a: "dismissed", b: "accepted" });
    expect(parseFindingDispositionMap("not-json")).toEqual({});
  });

  it("persists per jobId in storage", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const jobId = "job_abc";
    writeFindingDispositions(jobId, { f1: "dismissed" }, storage);
    expect(storage.getItem(findingDispositionStorageKey(jobId))).toContain("f1");
    expect(readFindingDispositions(jobId, storage)).toEqual({ f1: "dismissed" });

    const next = setFindingDisposition(readFindingDispositions(jobId, storage), "f1", "accepted");
    writeFindingDispositions(jobId, next, storage);
    expect(readFindingDispositions(jobId, storage)).toEqual({ f1: "accepted" });

    writeFindingDispositions(jobId, setFindingDisposition(next, "f1", null), storage);
    expect(readFindingDispositions(jobId, storage)).toEqual({});
  });

  it("hides dismissed findings unless showDismissed is on", () => {
    const findings = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const dispositions = { "1": "dismissed" as const, "2": "accepted" as const };
    expect(filterFindingsByDisposition(findings, dispositions, { showDismissed: false }).map(f => f.id)).toEqual(["2", "3"]);
    expect(filterFindingsByDisposition(findings, dispositions, { showDismissed: true }).map(f => f.id)).toEqual(["1", "2", "3"]);
  });
});
