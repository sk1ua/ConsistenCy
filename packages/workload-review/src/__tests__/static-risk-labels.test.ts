import { describe, expect, it } from "vitest";
import { staticRiskLabelForFiles, type DomainFileResult } from "@consistency/schema";

function file(path: string, riskLabel: string, riskScore = 0, extra: Partial<DomainFileResult> = {}): DomainFileResult {
  return { path, riskScore, riskLabel, riskColor: "GREY", signals: { steps: ["style"] }, findings: [], confidence: 1, ...extra };
}

describe("static risk coverage labels", () => {
  it("does not call an unanalyzed or failed analysis Consistent", () => {
    expect(staticRiskLabelForFiles([])).toBe("Not Analyzed (deterministic analysis returned no scored files)");
    expect(staticRiskLabelForFiles([], { notAnalyzedReason: "deterministic stage failed" })).toBe("Not Analyzed (deterministic stage failed)");
    expect(staticRiskLabelForFiles([file("notes.md", "skipped", 0, { confidence: 0, signals: { steps: [] } })])).toContain("Not Analyzed");
    expect(staticRiskLabelForFiles([])).not.toBe("Consistent");
  });

  it("labels No Baseline only when every analyzed file lacks a baseline", () => {
    expect(staticRiskLabelForFiles([file("src/new.py", "No Baseline")], { missingBaseline: true })).toBe("No Baseline");
    expect(staticRiskLabelForFiles([
      file("src/new.py", "No Baseline"), file("docs/change.md", "No Baseline", 0, { confidence: 0, signals: { steps: [] } }),
    ], { analyzedPaths: ["src/new.py"], missingBaseline: true })).toBe("No Baseline");
  });

  it("scores baselined files when a new changeset file is also present", () => {
    const label = staticRiskLabelForFiles([
      file("src/app.py", "Moderate Drift", 0.4),
      file(".changeset/note.md", "No Baseline", 0, { confidence: 0, signals: { steps: [] } }),
    ], { analyzedPaths: ["src/app.py"], baselinedPaths: ["src/app.py"], newFileCount: 1 });
    expect(label).toBe("Moderate Drift / 1 new file");
    expect(label).not.toContain("No Baseline");
  });

  it("keeps a severe baselined peak and discloses several new files", () => {
    expect(staticRiskLabelForFiles([
      file("src/app.py", "Severe Drift", 0.9),
      file("a.md", "No Baseline"), file("b.md", "No Baseline"),
    ], { analyzedPaths: ["src/app.py"], baselinedPaths: ["src/app.py"], newFileCount: 2 })).toBe("Severe Drift / 2 new files");
  });
});
