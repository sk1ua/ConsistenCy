/**
 * Evidence grounding tests — AC-REV-9, AC-REV-10, and the §41 end-to-end
 * grounding trace (snapshot → analyzer → Evidence → evidenceIds → report).
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ReviewFinding, TokenUsage } from "@consistency/schema";
import { parseReviewReport } from "@consistency/schema";
import {
  ReviewWorkload,
  type ModelDriver,
  type ReviewWorkloadOptions,
} from "../index.js";
import {
  FAKE_TOKEN,
  TestModelDriver,
  TestPersistence,
  cleanupTmpDirs,
  makeDeterministicStage,
  makeFixtureRepo,
  securityFinding,
} from "./fixtures.js";

afterEach(cleanupTmpDirs);

function rigWithDriver(driver: ModelDriver, hook?: ReviewWorkloadOptions["onAgentAdmitted"]) {
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
  };
  return { repo, persistence, workload: new ReviewWorkload(options) };
}

describe("ReviewWorkload — evidence grounding", () => {
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
