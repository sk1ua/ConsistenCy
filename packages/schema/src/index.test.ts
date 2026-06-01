import prReportFixture from "../../../tests/fixtures/pr_report_minimal.json" assert { type: "json" };
import { describe, expect, it } from "vitest";
import { jsonSchemas, parsePRReport, prReportSchema } from "./index";

describe("@consistency/schema", () => {
  it("exports the JSON Schema contracts", () => {
    expect(jsonSchemas.prReport.title).toBe("ConsistenCy PR risk report");
    expect(jsonSchemas.analysisResult.title).toBe("ConsistenCy source analysis result");
  });

  it("parses the golden PR report fixture", () => {
    const parsed = parsePRReport(prReportFixture);
    expect(parsed.base_ref).toBe("base123");
    expect(parsed.top_risky_files[0]?.file).toBe("docs/EVALUATION.md");
  });

  it("rejects incomplete PR reports", () => {
    expect(() => prReportSchema.parse({ base_ref: "main" })).toThrow();
  });
});
