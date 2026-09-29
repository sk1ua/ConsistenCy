import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "@consistency/schema";
import { workflowRunToAnalyzeResult } from "./workflowAdapter";

function artifact(overrides: Partial<WorkflowRun["artifacts"][number]> = {}): WorkflowRun["artifacts"][number] {
  return {
    stepId: "security",
    uses: "engine.security",
    status: "succeeded",
    command: [],
    exitCode: 0,
    startedAt: "2026-08-05T12:00:00.000Z",
    rawOutput: "",
    inputDigest: "a".repeat(64),
    ...overrides
  } as WorkflowRun["artifacts"][number];
}

function evidence(items: Array<Record<string, unknown>>, producedBy = "security") {
  return {
    producedBy,
    summary: "",
    items: items.map(item => ({ metadata: {}, excerpt: "", ...item }))
  } as WorkflowRun["artifacts"][number]["evidence"];
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "run_1",
    specName: "pr-review",
    status: "succeeded",
    startedAt: "2026-08-05T12:00:00.000Z",
    artifacts: [],
    ...overrides
  } as WorkflowRun;
}

describe("workflowRunToAnalyzeResult", () => {
  it("groups evidence by file and preserves the analysis contract", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [artifact({
        evidence: evidence([
          { file: "a.py", excerpt: "hardcoded secret", severity: "high", rule: "engine.security", startLine: 4 },
          { file: "b.py", excerpt: "unused import", severity: "low", rule: "engine.style" }
        ])
      })]
    }));

    expect(result.ok).toBe(true);
    expect(result.files.map(file => file.path)).toEqual(["a.py", "b.py"]);
    expect(result.files[0]?.findings[0]).toContain("hardcoded secret");
    expect(result.files[0]?.findings[0]).toContain("(line 4)");
  });

  it("prefers the analyzer's own score over the severity fallback", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [artifact({
        evidence: evidence([
          { file: "a.py", excerpt: "x", severity: "low", metadata: { score: 0.93 } }
        ])
      })]
    }));

    // severity "low" would map to 0.25; the calibrated score must win.
    expect(result.files[0]?.riskScore).toBeCloseTo(0.93, 4);
    expect(result.files[0]?.riskLabel).toBe("Severe Drift");
    expect(result.files[0]?.riskColor).toBe("RED");
  });

  it("takes the highest score for a file rather than averaging it down", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [
        artifact({ stepId: "security", evidence: evidence([{ file: "a.py", excerpt: "severe", severity: "critical" }]) }),
        artifact({ stepId: "style", uses: "engine.style", evidence: evidence([
          { file: "a.py", excerpt: "trivial", severity: "info" },
          { file: "a.py", excerpt: "also trivial", severity: "info" }
        ], "style") })
      ]
    }));

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.riskScore).toBeCloseTo(0.9, 4);
    expect(result.files[0]?.findings).toHaveLength(3);
    expect(result.files[0]?.signals).toEqual({ steps: ["security", "style"] });
  });

  it("P1-09: mixed step failure still projects succeeded evidence (does not abort the analyze contract)", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      status: "failed",
      artifacts: [
        artifact({
          stepId: "security",
          evidence: evidence([{ file: "a.py", excerpt: "hardcoded secret", severity: "high", rule: "engine.security", startLine: 4 }])
        }),
        artifact({ stepId: "style", status: "failed", uses: "engine.style" })
      ]
    }));
    expect(result.ok).toBe(true);
    expect(result.files.map(file => file.path)).toEqual(["a.py"]);
    expect((result.consensus as { status: string; steps: Array<{ status: string }> }).status).toBe("failed");
    expect((result.consensus as { steps: Array<{ status: string }> }).steps.map(step => step.status)).toEqual(["succeeded", "failed"]);
  });

  it("ignores evidence from steps that did not succeed", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [
        artifact({ status: "failed", evidence: evidence([{ file: "a.py", excerpt: "stale", severity: "critical" }]) }),
        artifact({ stepId: "skipped", status: "skipped", evidence: evidence([{ file: "b.py", excerpt: "x" }], "skipped") })
      ]
    }));

    // A missing analyzer must reduce coverage, never silently reduce risk.
    expect(result.files).toEqual([]);
  });

  it("returns no files when a run produced no evidence", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({ artifacts: [artifact()] }));
    expect(result.files).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("records step provenance in consensus for auditing", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [artifact({ durationMs: 12 })]
    }));

    expect(result.consensus).toMatchObject({ workflow: "pr-review", runId: "run_1", status: "succeeded" });
    expect((result.consensus as { steps: unknown[] }).steps).toEqual([
      { stepId: "security", uses: "engine.security", status: "succeeded", durationMs: 12 }
    ]);
  });

  it("clamps an out-of-range analyzer score", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [artifact({ evidence: evidence([{ file: "a.py", excerpt: "x", metadata: { score: 5 } }]) })]
    }));
    expect(result.files[0]?.riskScore).toBe(1);
  });

  it("P1-06: carries the workflow evidence into the retrieval trace instead of dropping it", () => {
    const result = workflowRunToAnalyzeResult("req-1", run({
      artifacts: [
        artifact({
          evidence: evidence([
            { file: "a.py", excerpt: "hardcoded secret", severity: "high", rule: "engine.security", startLine: 4 },
            { file: "a.py", excerpt: "second signal", severity: "low", rule: "engine.security", startLine: 9 }
          ])
        }),
        artifact({ stepId: "style", uses: "engine.style", evidence: evidence([{ file: "b.py", excerpt: "unused import", rule: "engine.style" }], "style") })
      ]
    }));

    const trace = result.evidencePack;
    expect(trace).toBeDefined();
    expect(trace!.strategy).toBe("workflow:pr-review");
    expect(trace!.packs.map(pack => pack.file)).toEqual(["a.py", "b.py"]);
    expect(trace!.packs[0]?.selected_evidence).toHaveLength(2);
    expect(trace!.packs[0]?.selected_evidence[0]?.candidate).toMatchObject({
      file: "a.py",
      kind: "changed_hunk",
      content: "hardcoded secret",
      start_line: 4
    });
    expect(trace!.packs[0]?.query.risk_terms).toEqual(["engine.security"]);
    expect(trace!.packs[1]?.query.metadata).toMatchObject({ workflow: "pr-review", runId: "run_1" });
    expect(trace!.summary).toMatchObject({
      files_with_evidence: 2,
      total_selected_evidence: 3,
      average_selected_evidence_count: 1.5
    });
  });

  it("P1-06: omits the retrieval trace only when the run truly produced no evidence", () => {
    expect(workflowRunToAnalyzeResult("req-1", run({ artifacts: [artifact()] })).evidencePack).toBeUndefined();
    expect(workflowRunToAnalyzeResult("req-1", run({
      artifacts: [artifact({ status: "failed", evidence: evidence([{ file: "a.py", excerpt: "stale" }]) })]
    })).evidencePack).toBeUndefined();
  });
});
