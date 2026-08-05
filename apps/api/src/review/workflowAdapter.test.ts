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
});
