import { afterEach, describe, expect, it } from "vitest";
import { ReviewWorkload } from "../index.js";
import { summaryForFinalFindings } from "../synthesis/summary.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, securityFinding, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

describe("verbatim summary prose", () => {
  it.each([
    "fixes two bugs", "no new security risk", "修复了两个问题",
    "Found five review findings. High: 5. There are 99 issues.",
    "发现七条高危问题，参数拼接导致注入；附录：9条。",
    "  Leading spaces and trailing newlines stay intact.\n\n",
  ])("does not edit any character in %s", source => {
    const summary = summaryForFinalFindings(source, [securityFinding(), { ...securityFinding(), id: "second" }, { ...securityFinding(), id: "third" }]);
    expect(summary.slice(0, source.length)).toBe(source);
    expect(summary.slice(source.length)).toBe("\n\nAfter deduplication and filtering: 3 main-list findings (0 critical, 3 high, 0 medium, 0 low, 0 info); 0 appendix issues.");
  });

  it("follows the explicit language for the footer instead of guessing from body text", () => {
    expect(summaryForFinalFindings("修复了两个问题", [], [], "en-US")).toBe("修复了两个问题\n\nAfter deduplication and filtering: 0 main-list findings (0 critical, 0 high, 0 medium, 0 low, 0 info); 0 appendix issues.");
    expect(summaryForFinalFindings("fixes two bugs", [], [], "zh-CN")).toBe("fixes two bugs\n\n去重和过滤后：主列表 0 条（严重 0、高 0、中 0、低 0、信息 0），附录 0 条。");
  });

  it.each(["en-US", "zh-CN"] as const)("keeps model whitespace intact and requests %s throughout the workload", async language => {
    const repo = makeFixtureRepo();
    const source = "  fixes two bugs; no new security risk; 修复了两个问题  \n";
    const driver = new TestModelDriver({ summary: source, findingsByAgent: { Security: [securityFinding()] } });
    const result = await new ReviewWorkload({
      snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
      deterministic: makeDeterministicStage(), persistence: new TestPersistence(),
      reportLanguage: language, publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    expect(result.report.summary.slice(0, source.length)).toBe(source);
    expect(driver.requests.find(request => request.schemaName === "review-summary")!.systemPrompt)
      .toContain(language === "zh-CN" ? "Chinese" : "English");
    expect(result.report.summary).toContain(language === "zh-CN" ? "主列表 1 条" : "1 main-list finding");
  });
});
