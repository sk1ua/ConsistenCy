import { describe, expect, it } from "vitest";
import { staticRiskLabelForFiles, type WorkflowRun } from "@consistency/schema";
import { workflowRunToAnalyzeResult } from "./workflowAdapter";

const emptyRun: WorkflowRun = {
  runId: "run_baseline", specName: "pr-review", status: "succeeded",
  startedAt: "2026-09-30T12:00:00.000Z", artifacts: [],
};

describe("default workflow baseline disclosure", () => {
  it("retains added and missing-baseline files even without workflow findings", () => {
    const result = workflowRunToAnalyzeResult("req_baseline", emptyRun, [
      { path: "added.py" }, { path: "missing.py" }, { path: "existing.py", baseline: "" },
    ]);
    expect(result.files.map(file => file.path)).toEqual(["added.py", "missing.py"]);
    expect(result.files.every(file => file.riskLabel === "No Baseline" && file.confidence === 0)).toBe(true);
    expect(staticRiskLabelForFiles(result.files)).toBe("No Baseline");
  });

  it("keeps severe head-file evidence visible alongside missing and skipped baselines", () => {
    const run: WorkflowRun = { ...emptyRun, artifacts: [{
      stepId: "security", uses: "engine.security", status: "succeeded", command: [], exitCode: 0,
      startedAt: emptyRun.startedAt, rawOutput: "", inputDigest: "a".repeat(64),
      evidence: { producedBy: "security", summary: "", items: [{
        file: "z-danger.py", excerpt: "attacker-controlled command", severity: "critical", metadata: { score: 0.9 },
      }] },
    }] };
    const result = workflowRunToAnalyzeResult("req_baseline", run, [
      { path: "a-added.py" }, { path: "z-danger.py", baseline: "safe()" },
      { path: "skipped.py", baselineSkipped: true },
    ]);
    expect(result.files[0]?.riskLabel).toBe("No Baseline");
    expect(staticRiskLabelForFiles(result.files)).toBe("Severe Drift / No Baseline / skipped");
    expect(staticRiskLabelForFiles([...result.files].reverse())).toBe(staticRiskLabelForFiles(result.files));
  });
});
