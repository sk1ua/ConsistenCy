/**
 * Evidence store + fingerprint tests — AC-EVID-1 … AC-EVID-6 plus the
 * evidence access-authorization integration (syscall model, §34).
 */

import { describe, it, expect } from "vitest";
import {
  CapabilityBroker,
  CapabilityError,
  CanonicalizationError,
  EvidenceIdConflictError,
  EvidenceStore,
  EvidenceValidationError,
  MemoryJournal,
  SyscallGateway,
  asEvidenceId,
  computeEvidenceFingerprint,
  makePrincipalId,
  type EvidenceInput,
  type EvidenceResource,
  type Principal,
} from "../index.js";

const BASE: Omit<EvidenceInput, "payload" | "confidence" | "ruleId"> = {
  source: "ast",
  location: { path: "src/foo.ts", startLine: 3, endLine: 3 },
  provenance: {
    repository: "sk1ua/ConsistenCy",
    sha: "abc123def456",
    analyzer: "style",
    analyzerVersion: "1.0.0",
  },
};

function makeInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    ...BASE,
    confidence: 0.9,
    payload: { kind: "style", message: "trailing whitespace", excerpt: "const x = 1; " },
    ruleId: "style.trailing-whitespace",
    ...overrides,
  };
}

describe("EvidenceStore — deterministic identity", () => {
  it("AC-EVID-1: same semantic input → same fingerprint", () => {
    const store = new EvidenceStore();
    const a = store.add(makeInput());
    const b = store.add(makeInput());
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.id).not.toBe(b.id);
    expect(store.count()).toBe(2);
  });

  it("AC-EVID-2: object key insertion order does not alter the fingerprint", () => {
    const a = computeEvidenceFingerprint(
      makeInput({ payload: { kind: "style", message: "m", excerpt: "e" } }),
    );
    const b = computeEvidenceFingerprint(
      makeInput({ payload: { excerpt: "e", message: "m", kind: "style" } }),
    );
    const c = computeEvidenceFingerprint(
      makeInput({ payload: { message: "m", excerpt: "e", kind: "style" } }),
    );
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("AC-EVID-3: different snapshot SHA changes the fingerprint", () => {
    const store = new EvidenceStore();
    const a = store.add(makeInput());
    const b = store.add(
      makeInput({ provenance: { ...BASE.provenance, sha: "999999999999" } }),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("AC-EVID-4: different rule / location / analyzerVersion change the fingerprint", () => {
    const store = new EvidenceStore();
    const base = store.add(makeInput());
    const otherRule = store.add(makeInput({ ruleId: "style.line-too-long" }));
    const otherLine = store.add(makeInput({ location: { path: "src/foo.ts", startLine: 9, endLine: 9 } }));
    const otherPath = store.add(makeInput({ location: { path: "src/bar.ts", startLine: 3, endLine: 3 } }));
    const otherVersion = store.add(
      makeInput({ provenance: { ...BASE.provenance, analyzerVersion: "2.0.0" } }),
    );
    expect(new Set([base, otherRule, otherLine, otherPath, otherVersion].map((e) => e.fingerprint)).size).toBe(5);
  });

  it("AC-EVID-5: invalid confidence is rejected (NaN, Infinity, -1, 2.5)", () => {
    const store = new EvidenceStore();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5, 1.0001]) {
      expect(() => store.add(makeInput({ confidence: bad }))).toThrow(EvidenceValidationError);
      expect(() => computeEvidenceFingerprint(makeInput({ confidence: bad }))).toThrow(RangeError);
    }
    expect(() => store.add(makeInput({ confidence: 0 }))).not.toThrow();
    expect(() => store.add(makeInput({ confidence: 1 }))).not.toThrow();
  });

  it("AC-EVID-6: public evidence snapshots cannot mutate the store", () => {
    const store = new EvidenceStore();
    const record = store.add(makeInput({ payload: { kind: "style", nested: { values: [1, 2, 3] } } }));

    const snapshot = store.get(record.id)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.payload)).toBe(true);
    expect(Object.isFrozen((snapshot.payload as { nested: unknown }).nested)).toBe(true);
    expect(Object.isFrozen((snapshot.payload as { nested: { values: unknown[] } }).nested.values)).toBe(true);

    expect(() => {
      (snapshot as { confidence: number }).confidence = 0.1;
    }).toThrow(TypeError);
    expect(() => {
      ((snapshot.payload as { nested: { values: unknown[] } }).nested.values as unknown[]).push(4);
    }).toThrow(TypeError);

    // Store unaffected.
    expect(store.get(record.id)!.confidence).toBe(0.9);
    expect(store.get(record.id)!.payload).toEqual({ kind: "style", nested: { values: [1, 2, 3] } });
  });

  it("rejects unsupported payload values at fingerprint time (fail closed)", () => {
    expect(() =>
      computeEvidenceFingerprint(makeInput({ payload: { bad: undefined as never } })),
    ).toThrow(CanonicalizationError);
    expect(() =>
      computeEvidenceFingerprint(makeInput({ payload: { bad: 10n as never } })),
    ).toThrow(CanonicalizationError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => computeEvidenceFingerprint(makeInput({ payload: cyclic as never }))).toThrow();
  });

  it("normalizes Windows separators and rejects unsafe paths", () => {
    const store = new EvidenceStore();
    const normalized = store.add(makeInput({ location: { path: "src\\foo\\bar.ts", startLine: 1 } }));
    expect(normalized.location.path).toBe("src/foo/bar.ts");
    expect(normalized.fingerprint).toBe(
      computeEvidenceFingerprint(makeInput({ location: { path: "src/foo/bar.ts", startLine: 1 } })),
    );

    for (const bad of ["/etc/passwd", "..\\secret.ts", "../secret.ts", "a/../../b.ts", "src/\0x.ts", ""]) {
      expect(() => store.add(makeInput({ location: { path: bad } }))).toThrow(EvidenceValidationError);
    }
  });

  it("rejects duplicate ids and validates line semantics", () => {
    const store = new EvidenceStore();
    const id = asEvidenceId("evid_1");
    store.add(makeInput(), { id });
    expect(() => store.add(makeInput(), { id })).toThrow(EvidenceIdConflictError);

    expect(() =>
      store.add(makeInput({ location: { path: "a.ts", startLine: 0 } })),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      store.add(makeInput({ location: { path: "a.ts", startLine: 5, endLine: 3 } })),
    ).toThrow(EvidenceValidationError);
  });

  it("queries deterministically by sha/path/source/ruleId", () => {
    const store = new EvidenceStore();
    store.add(makeInput({ ruleId: "r1", provenance: { ...BASE.provenance, sha: "s1" } }));
    store.add(makeInput({ ruleId: "r2", provenance: { ...BASE.provenance, sha: "s1" }, location: { path: "src/z.ts" } }));
    store.add(makeInput({ ruleId: "r1", provenance: { ...BASE.provenance, sha: "s2" } }));

    expect(store.query({ sha: "s1" })).toHaveLength(2);
    expect(store.query({ ruleId: "r1" })).toHaveLength(2);
    expect(store.query({ path: "src/z.ts" })).toHaveLength(1);
    expect(store.query({ sha: "s1", ruleId: "r1" })).toHaveLength(1);
    expect(store.query({ sha: "nope" })).toHaveLength(0);

    const bySha = store.query().map((e) => e.provenance.sha);
    expect(bySha).toEqual([...bySha].sort());
  });

  it("evidence access goes through the Kernel syscall model (authorization integration)", async () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const gateway = new SyscallGateway(broker);
    const agent: Principal = { id: makePrincipalId("agent", "ev", "run-1"), kind: "agent", runId: "run-1" };
    const resource: EvidenceResource = { kind: "evidence", runId: "run-1" };

    const store = new EvidenceStore();
    store.add(makeInput());

    // With an evidence.read capability: the syscall is allowed.
    const handle = broker.issue({ subject: agent, action: "evidence.read", resource });
    const outcome = await gateway.invoke(
      { principal: agent, handle, action: "evidence.read", resource },
      () => ({ value: store.query().length }),
    );
    expect(outcome).toBe(1);

    // With evidence.write capability: storing is allowed (revertible effect).
    const writeHandle = broker.issue({ subject: agent, action: "evidence.write", resource });
    const written = await gateway.invoke(
      { principal: agent, handle: writeHandle, action: "evidence.write", resource },
      () => ({ value: store.add(makeInput({ ruleId: "r3" })).id }),
    );
    expect(store.count()).toBe(2);
    expect(store.get(written)).toBeDefined();

    // Without a capability: denied — the store is not directly reachable.
    await expect(
      gateway.invoke(
        { principal: agent, handle, action: "evidence.write", resource },
        () => ({ value: "never" }),
      ),
    ).rejects.toMatchObject({ name: "CapabilityError", reason: "action_mismatch" } satisfies Partial<CapabilityError>);
  });
});
