/**
 * Completion notice tests — H15 (terminal one-shot summaries).
 *
 *   TEST N1  idempotency key: deterministic `completion:<runId>:<attempt>`,
 *            so duplicate terminal triggers never create a second notice.
 *   TEST N2  allowlist projection: only schema fields exist; prompt-like or
 *            unexpected payload content in the terminal input is dropped.
 *   TEST N3  redaction before persistence: bearer tokens, API keys,
 *            passwords, and absolute local paths never survive into the
 *            notice error or evidence paths.
 *   TEST N4  evidence by reference only: id/path/fingerprint, capped at the
 *            documented maximum, total count preserved.
 *   TEST N5  remaining budget: reported only when the runtime tracks one.
 *   TEST N6  terminal reason mapping mirrors the execution-event ledger.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_NOTICE_EVIDENCE_REFS,
  buildCompletionNotice,
  completionIdempotencyKey,
  completionNoticeSchema,
} from "./notices";

const FINISHED_AT = "2026-09-26T00:01:00.000Z";
const NOW = "2026-09-26T00:01:00.100Z";

function evidenceRecord(index: number) {
  return {
    id: `wfev_${index}`,
    source: "deterministic",
    ruleId: "style.long-function",
    path: `src/module_${index}.ts`,
    startLine: 10 + index,
    endLine: 40 + index,
    confidence: 0.9,
    fingerprint: `fp_${index}`.repeat(4),
    analyzer: "style-analyzer",
    analyzerVersion: "1.0.0",
    repository: "test/fixture-canonical",
    sha: "a".repeat(40),
  };
}

function terminalInput(overrides: Record<string, unknown> = {}) {
  const evidence = Array.from({ length: 4 }, (_, index) => evidenceRecord(index));
  return {
    runId: "wfrun_test-0001",
    status: "succeeded" as const,
    finishedAt: FINISHED_AT,
    evidence,
    miniReport: {
      definitionId: "def-mini-review",
      runId: "wfrun_test-0001",
      status: "succeeded",
      repository: "test/fixture-canonical",
      headSha: "b".repeat(40),
      startedAt: "2026-09-26T00:00:00.000Z",
      finishedAt: FINISHED_AT,
      evidenceCount: evidence.length,
      verifiedEvidenceCount: evidence.length,
      findings: [{ id: "finding-001", nodeId: "verify", file: "src/a.ts", title: "t", confidence: 0.9, evidenceIds: ["wfev_0"], verified: true }],
      agents: [],
      audit: { allowed: 6, denied: 0 },
    },
    ...overrides,
  };
}

describe("completion notices (H15)", () => {
  it("TEST N1: derives a deterministic idempotency key from runId + attempt", () => {
    expect(completionIdempotencyKey("wfrun_abc", 1)).toBe("completion:wfrun_abc:1");
    expect(completionIdempotencyKey("wfrun_abc", 2)).toBe("completion:wfrun_abc:2");

    const first = buildCompletionNotice(terminalInput(), { now: NOW });
    const second = buildCompletionNotice(terminalInput(), { now: "2026-09-26T00:09:00.000Z" });
    // Same run terminal, recorded twice (duplicate trigger) ⇒ same key.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.attempt).toBe(1);
  });

  it("TEST N2: projects an allowlist — no prompt or payload content is transported", () => {
    const notice = buildCompletionNotice(
      terminalInput({
        miniReport: {
          definitionId: "def-mini-review",
          repository: "test/fixture-canonical",
          headSha: "b".repeat(40),
          evidenceCount: 4,
          findings: [],
          // An LLM-style payload that must never leak into the notice:
          prompt: "You are reviewing a private repository. The API key is sk-abcdefghijklmnopqrst",
          messages: [{ role: "user", content: "private prompt body" }],
          fileContents: { "src/a.ts": "private source text" },
        },
        evidence: [],
      }),
      { now: NOW },
    );

    // Strict schema: exactly the allowlisted keys (optional ones absent).
    expect(Object.keys(notice).sort()).toEqual([
      "attempt", "createdAt", "definitionId", "evidence", "evidenceCount",
      "findingsCount", "finishedAt", "headSha", "idempotencyKey", "repository", "result",
      "runId", "terminalReason",
    ]);
    expect(JSON.stringify(notice)).not.toContain("private prompt body");
    expect(JSON.stringify(notice)).not.toContain("private source text");
    expect(JSON.stringify(notice)).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("TEST N3: redacts secrets and absolute paths before persistence", () => {
    const notice = buildCompletionNotice(
      terminalInput({
        status: "failed",
        error: [
          "provider call failed with Authorization: Bearer sup3rs3crettokenvalue",
          "for key sk-abcdefghijklmnopqrstuvwx at D:\\Users\\dev\\secret\\project\\src\\leak.ts",
          "password=hunter2",
        ].join("; "),
        evidence: [{
          ...evidenceRecord(0),
          path: "D:\\Users\\dev\\secret\\project\\src\\module_0.ts",
        }],
      }),
      { now: NOW },
    );

    expect(notice.result).toBe("failed");
    expect(notice.error).toBeDefined();
    expect(notice.error).not.toContain("sup3rs3crettokenvalue");
    expect(notice.error).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(notice.error).not.toContain("hunter2");
    expect(notice.error).not.toContain("D:\\Users\\dev");
    expect(notice.error).toContain("[REDACTED]");

    expect(notice.evidence[0]!.path).not.toContain("D:\\Users\\dev");
    // Round-trips through the strict schema.
    expect(() => completionNoticeSchema.parse(notice)).not.toThrow();
  });

  it("TEST N4: carries evidence by reference, capped, with the total preserved", () => {
    const many = Array.from({ length: MAX_NOTICE_EVIDENCE_REFS + 20 }, (_, index) => evidenceRecord(index));
    const notice = buildCompletionNotice(
      terminalInput({ evidence: many, miniReport: { ...terminalInput().miniReport, evidenceCount: many.length, findings: [] } }),
      { now: NOW },
    );

    expect(notice.evidence).toHaveLength(MAX_NOTICE_EVIDENCE_REFS);
    expect(notice.evidenceCount).toBe(many.length);
    for (const ref of notice.evidence) {
      expect(Object.keys(ref).sort()).toEqual(["fingerprint", "id", "path"]);
      expect(ref.path).not.toMatch(/content|prompt/i);
    }
  });

  it("TEST N5: reports remaining budget only when the runtime tracked one", () => {
    const withoutBudget = buildCompletionNotice(terminalInput(), { now: NOW });
    expect("remainingBudget" in withoutBudget).toBe(false);

    const withBudget = buildCompletionNotice(
      terminalInput({ remainingBudget: { remainingTokens: 4321, remainingWallTimeMs: 1200 } }),
      { now: NOW },
    );
    expect(withBudget.remainingBudget).toEqual({ remainingTokens: 4321, remainingWallTimeMs: 1200 });
  });

  it("TEST N6: maps terminal reasons consistently with the execution-event ledger", () => {
    const succeeded = buildCompletionNotice(terminalInput(), { now: NOW });
    const failed = buildCompletionNotice(terminalInput({ status: "failed", error: "boom" }), { now: NOW });
    expect(succeeded.terminalReason).toBe("completed");
    expect(failed.terminalReason).toBe("fatal_error");
  });
});
