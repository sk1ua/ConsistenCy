/**
 * Evidence grounding tests — AC-REV-9, AC-REV-10, and the §41 end-to-end
 * grounding trace (snapshot → analyzer → Evidence → evidenceIds → report).
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ReviewFinding, TokenUsage } from "@consistency/schema";
import { parseReviewReport } from "@consistency/schema";
import { EvidenceStore } from "@consistency/kernel";
import { changedLineRanges } from "../agents/grounding.js";
import {
  ReviewWorkload,
  buildGroundingContext,
  groundReviewFindings,
  type GroundingContext,
  type ModelDriver,
  type ReviewWorkloadOptions,
} from "../index.js";
import {
  FAKE_TOKEN,
  TestModelDriver,
  TestPersistence,
  cleanupTmpDirs,
  makeDeterministicStage,
  makeEvidenceInput,
  makeFixtureRepo,
  securityFinding,
} from "./fixtures.js";

afterEach(cleanupTmpDirs);

it("tracks added lines exactly and moves all off-diff confidence levels to the appendix", () => {
  expect(changedLineRanges("@@ -8,4 +8,5 @@\n context\n-old\n+new\n context\n+another\n context")).toEqual([
    { start: 9, end: 9 }, { start: 11, end: 11 }
  ]);
  const grounding: GroundingContext = { files: new Map([["src/index.ts", {
    changedRanges: [{ start: 10, end: 10 }], lineCount: 30, hasDeterministicSignal: true
  }]]) };
  const base = { ...securityFinding(), startLine: 14, endLine: 14 };
  const findings: ReviewFinding[] = [
    { ...base, id: "confirmed", confidence: "confirmed" },
    { ...base, id: "likely", confidence: "likely" },
    { ...base, id: "hypothesis", confidence: "hypothesis", uncertainty: "Needs runtime confirmation" },
  ];
  const result = groundReviewFindings(findings, grounding, new EvidenceStore(), "a".repeat(40));
  expect(result.findings).toHaveLength(0);
  expect(result.preExisting).toHaveLength(3);
});

function rigWithDriver(driver: ModelDriver, hook?: ReviewWorkloadOptions["onAgentAdmitted"], maxFindingsPerSpecialist?: number) {
  const repo = makeFixtureRepo();
  const persistence = new TestPersistence();
  const options: ReviewWorkloadOptions = {
    snapshot: repo.snapshot,
    context: repo.context,
    modelDriver: driver,
    deterministic: makeDeterministicStage(),
    persistence,
    reportLanguage: "en-US",
    publicationPolicy: "github_comment",
    accessMode: "github_app",
    onAgentAdmitted: hook,
    maxFindingsPerSpecialist,
  };
  return { repo, persistence, workload: new ReviewWorkload(options) };
}

describe("ReviewWorkload — evidence grounding", () => {
  it("caps grounded findings per specialist after ranking severity", async () => {
    const findings = (["low", "medium", "high", "info"] as const).map((severity, index) => ({
      ...securityFinding(), id: `cap-${index}`, title: ["Alpha", "Beta", "Gamma", "Delta"][index]!,
      severity, confidence: "likely" as const
    }));
    const driver = new TestModelDriver({ findingsByAgent: { Security: findings } });
    const { workload } = rigWithDriver(driver, undefined, 2);
    const result = await workload.run();
    // The cap runs after grounding and before synthesis, so it is asserted on
    // the aggregated specialist findings. These four fixtures deliberately
    // share one location, and step 3 then groups whichever two survive into a
    // single reported issue — the report can therefore never hold more than
    // the capped count.
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map(finding => finding.severity).sort()).toEqual(["high", "medium"]);
    expect(result.report.findings.length).toBeLessThanOrEqual(2);
  });

  it("AC-REV-9: actionable findings reference valid evidenceIds (§41 grounding trace)", async () => {
    const driver = new TestModelDriver({ findingsByAgent: { Security: [securityFinding()] } });
    const { repo, workload } = rigWithDriver(driver);
    const result = await workload.run();

    const finding = result.report.findings.find((f) => f.id === "finding-1");
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("confirmed");
    const ids = finding!.evidenceIds ?? [];
    expect(ids.length).toBeGreaterThan(0);

    // Every referenced id resolves to a REAL evidence record for THIS sha.
    const byId = new Map<string, (typeof result.evidence)[number]>(result.evidence.map((e) => [e.id, e]));
    for (const id of ids) {
      expect(byId.has(id)).toBe(true);
      expect(byId.get(id)!.provenance.sha).toBe(repo.headSha);
    }
    // The synthetic secret on line 2 is the corroborating evidence.
    const secretEvidence = result.evidence.find((e) => e.ruleId === "secret.github-token");
    expect(secretEvidence).toBeDefined();
    expect(ids).toContain(secretEvidence!.id);
    // No raw secret in the serialized report.
    expect(JSON.stringify(result.report)).not.toContain(FAKE_TOKEN);
    expect(parseReviewReport(JSON.parse(JSON.stringify(result.report)))).toBeTruthy();

    // Audit P1-06② invariant: nothing in the report claims confirmation
    // without an evidence anchor.
    for (const reported of result.report.findings) {
      if (reported.confidence === "confirmed") {
        expect((reported.evidenceIds ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  it("AC-REV-10: a finding referencing an unknown EvidenceId is rejected", async () => {
    const findings: ReviewFinding[] = [
      { ...securityFinding(), id: "finding-bogus", evidenceIds: ["evid_does_not_exist"] },
    ];
    const driver: ModelDriver = {
      provider: "mock",
      model: "bogus-fixture",
      invokeStructured: async (request) => ({
        data: {
          enabledAgents: ["Security"],
          skippedAgents: ["Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"],
          riskAreas: ["changed code"],
          reason: "bogus plan",
          focusAreas: [],
        } as never,
      }),
      invokeAgentFindings: async () => ({ data: findings }),
      invokeSummary: async () => ({ data: { summary: "bogus summary" } }),
    };
    const { workload } = rigWithDriver(driver);
    const result = await workload.run();

    // The bogus finding was rejected before synthesis.
    expect(result.report.findings).toHaveLength(0);
    expect(result.findings.some((f) => f.id === "finding-bogus")).toBe(false);
  });

  it("AC-REV-10b: a model-supplied VALID evidence id is preserved", async () => {
    const findings: ReviewFinding[] = [{ ...securityFinding(), id: "finding-valid" }];
    let validEvidenceId: string | undefined;
    const driver: ModelDriver = {
      provider: "mock",
      invokeStructured: async () => ({
        data: {
          enabledAgents: ["Security"],
          skippedAgents: ["Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"],
          riskAreas: ["changed code"],
          reason: "valid plan",
          focusAreas: [],
        } as never,
      }),
      invokeAgentFindings: async () => ({
        data: findings.map((f) => (validEvidenceId ? { ...f, evidenceIds: [validEvidenceId] } : f)),
        tokenUsage: { totalTokens: 1 } satisfies TokenUsage,
      }),
      invokeSummary: async () => ({ data: { summary: "valid summary" } }),
    };
    const { workload } = rigWithDriver(driver, async ({ facades, agentName }) => {
      if (agentName !== "review-security") return;
      const records = await facades.evidence.list();
      const secret = records.find((r) => r.ruleId === "secret.github-token");
      if (secret) validEvidenceId = secret.id;
    });
    const result = await workload.run();

    const kept = result.report.findings.find((f) => f.id === "finding-valid");
    expect(kept).toBeDefined();
    expect(kept!.evidenceIds).toEqual([validEvidenceId]);
  });
});

describe("groundReviewFindings — confirmed requires an evidence anchor (audit P1-06②)", () => {
  const headSha = "a".repeat(40);

  function groundingWithSignal(): GroundingContext {
    return {
      files: new Map([
        ["src/index.ts", {
          changedRanges: [{ start: 1, end: 3 }],
          lineCount: 3,
          hasDeterministicSignal: true,
        }],
      ]),
    };
  }

  function confirmedFinding(): ReviewFinding {
    return {
      ...securityFinding(),
      file: "src/index.ts",
      startLine: 2,
      endLine: 2,
    };
  }

  it("downgrades a confirmed finding that passes hunk+signal gates but has no intersecting evidence record", () => {
    const store = new EvidenceStore();
    // One real record, but on a different path — nothing intersects.
    store.add(makeEvidenceInput({ location: { path: "docs/other.ts", startLine: 5, endLine: 5 } }));

    const result = groundReviewFindings([confirmedFinding()], groundingWithSignal(), store, headSha);

    expect(result.rejected).toHaveLength(0);
    expect(result.downgraded).toHaveLength(1);
    expect(result.downgraded[0]!.reason).toContain("No evidence record corroborates");
    const finding = result.findings[0]!;
    expect(finding.confidence).toBe("likely");
    expect(finding.evidenceIds).toBeUndefined();
  });

  it("keeps a confirmed finding confirmed exactly when an intersecting evidence record exists", () => {
    const store = new EvidenceStore();
    const record = store.add(makeEvidenceInput({
      location: { path: "src/index.ts", startLine: 2, endLine: 2 },
      provenance: { repository: "test/example", sha: headSha, analyzer: "secret", analyzerVersion: "1.0.0" },
    }));
    // Non-intersecting same-path record must not be enough on its own.
    store.add(makeEvidenceInput({
      location: { path: "src/index.ts", startLine: 40, endLine: 41 },
      provenance: { repository: "test/example", sha: headSha, analyzer: "secret", analyzerVersion: "1.0.0" },
    }));

    const result = groundReviewFindings([confirmedFinding()], groundingWithSignal(), store, headSha);

    expect(result.downgraded).toHaveLength(0);
    expect(result.findings[0]!.confidence).toBe("confirmed");
    expect(result.findings[0]!.evidenceIds).toEqual([record.id]);
  });

  it("an empty EvidenceStore never yields a confirmed finding", () => {
    const result = groundReviewFindings([confirmedFinding()], groundingWithSignal(), new EvidenceStore(), headSha);
    expect(result.findings[0]!.confidence).toBe("likely");
  });
});
