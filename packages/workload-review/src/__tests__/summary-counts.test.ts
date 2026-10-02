import { afterEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { ReviewWorkload, type ModelDriver } from "../index.js";
import { buildReviewReport } from "../synthesis/report.js";
import { summaryForFinalFindings } from "../synthesis/summary.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, securityFinding, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

const finding = (id: string, severity: ReviewFinding["severity"] = "high"): ReviewFinding => ({
  ...securityFinding(), id, severity,
});

describe("final summary counts", () => {
  it("appends final counts to already-counted prose without losing unrelated numbers", () => {
    const summary = summaryForFinalFindings(
      "Found 3 review findings. High: 0. Use a 5-second timeout and Python 3.12.",
      [finding("critical", "critical"), finding("low", "low"), finding("info", "info")],
      [finding("appendix")],
    );
    expect(summary).toContain("3 main-list findings (1 critical, 0 high, 0 medium, 1 low, 1 info)");
    expect(summary).toContain("1 appendix issue");
    expect(summary).toContain("Use a 5-second timeout and Python 3.12.");
    expect(summary).not.toContain("five review findings");
    expect(summary).not.toContain("High: 5");
  });

  it("uses localized final-list counts without altering Chinese prose", () => {
    const summary = summaryForFinalFindings("发现了1条高危问题。超时设置为5秒。", [finding("main")], [], "zh-CN");
    expect(summary).toContain("主列表 1 条（严重 0、高 1、中 0、低 0、信息 0），附录 0 条");
    expect(summary).toContain("超时设置为5秒。");
    expect(summary).not.toContain("十条高危问题");
  });

  it("preserves explanations and unrelated numbers in the same count-bearing English sentence", () => {
    const summary = summaryForFinalFindings(
      "Found 1 review finding: concatenated SQL permits injection; restore parameter binding and retain the 300-second timeout on Python 3.12.",
      [finding("main")], [], "en-US",
    );
    expect(summary).toContain("Found 1 review finding: concatenated SQL permits injection; restore parameter binding and retain the 300-second timeout on Python 3.12.");
    expect(summary).toContain("1 main-list finding");
    expect(summary).not.toContain("去重和过滤后");
    expect(summary).not.toContain("five review findings");
  });

  it("preserves Chinese explanation clauses with a requested Chinese footer", () => {
    const summary = summaryForFinalFindings(
      "发现1条高危问题，参数拼接导致注入，应恢复参数绑定并保留300秒超时和Python 3.12；附录：1条。",
      [finding("main")], [finding("base")], "zh-CN",
    );
    expect(summary).toContain("发现1条高危问题，参数拼接导致注入，应恢复参数绑定并保留300秒超时和Python 3.12；附录：1条。");
    expect(summary).toContain("主列表 1 条");
    expect(summary).not.toContain("After deduplication and filtering");
  });

  it("replaces only generated footers on repeat processing and leaves non-count risks and timing prose intact", () => {
    const source = "There is a risk of command execution; keep the 5-second timeout. 发现5秒延迟时应重试。";
    const once = summaryForFinalFindings(source, [finding("main")], [], "en-US");
    const twice = summaryForFinalFindings(once, [finding("main")], [], "en-US");
    expect(twice).toBe(once);
    expect(twice).toContain(source);
    expect(twice.match(/After deduplication and filtering/g)).toHaveLength(1);
  });

  it("derives counts after the report builder's last deduplication pass", () => {
    const first = finding("first");
    const report = buildReviewReport({
      jobId: "job_counts", repositoryFullName: "owner/repo", baseSha: "base", headSha: "head",
      summary: "A credential was exposed.", findings: [first, { ...first, id: "duplicate", agent: "Correctness" }],
      agentRuns: [], score: 80, riskLevel: "low",
    });
    expect(report.findings).toHaveLength(1);
    expect(report.duplicates).toHaveLength(1);
    expect(report.summary).toContain("1 main-list finding");
    expect(report.summary).not.toContain("Two findings");
  });

  it("counts after deduplication, score floor and cap, without another model call", async () => {
    const repo = makeFixtureRepo();
    const first = { ...finding("first"), trigger: "A public client retrieves the exposed credential" };
    const second = { ...finding("second"), title: "Pending timer survives cancellation", severity: "medium" as const, trigger: "The caller cancels a pending operation", evidence: "The timer remains scheduled after cancellation." };
    const third = { ...finding("third"), title: "Empty values bypass parsing", severity: "low" as const, trigger: "An empty value reaches the parser", evidence: "An empty value takes an unsupported parser branch." };
    const inner = new TestModelDriver({ findingsByAgent: {
      Security: [first, second, third], Correctness: [{ ...first, id: "duplicate", agent: "Correctness" }],
    } });
    let calls = 0;
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: async request => {
        calls += 1;
        const candidates = JSON.parse(request.userPrompt).findings as ReviewFinding[];
        expect(JSON.parse(request.userPrompt).findings).toHaveLength(3);
        expect(request.systemPrompt).toContain("Do not state finding counts");
        return { data: { summary: "Reject unsafe input.", scores: candidates.map(candidate => ({
          id: candidate.id, score: candidate.id === "second" ? 1 : candidate.id === "third" ? 8 : 9,
          reason: candidate.id === "second" ? "Below floor" : "Concrete impact",
        })) } };
      },
    };
    const result = await new ReviewWorkload({
      snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
      deterministic: makeDeterministicStage(), persistence: new TestPersistence(),
      reportLanguage: "en-US", publicationPolicy: "disabled", accessMode: "local_git", maxReportedFindings: 1,
    }).run();
    expect(calls).toBe(1);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.filteredFindingCount).toBe(2);
    expect(result.report.duplicates).toHaveLength(1);
    expect(result.report.summary).toContain("1 main-list finding (0 critical, 1 high, 0 medium, 0 low, 0 info)");
    expect(result.report.summary).toContain("Reject unsafe input.");
    expect(result.report.summary).not.toContain("four review findings");
  });

  it("deduplicates before the three-per-file cap so a duplicate cannot displace another issue", async () => {
    const repo = makeFixtureRepo();
    const first = finding("first");
    const timer = { ...finding("timer"), title: "Cancellation leaves scheduled callbacks", evidence: "Timer callbacks remain active after cancellation" };
    const parser = { ...finding("parser"), title: "Empty values bypass validation", evidence: "Empty input takes an unsupported parser branch" };
    const inner = new TestModelDriver({ findingsByAgent: {
      Security: [first, { ...first, id: "duplicate" }],
      Correctness: [timer, parser].map(f => ({ ...f, agent: "Correctness" as const })),
    } });
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: async request => {
        const candidates = JSON.parse(request.userPrompt).findings as ReviewFinding[];
        expect(candidates).toHaveLength(3);
        return { data: { summary: "Reject unsafe input.", scores: candidates.map(f => ({ id: f.id, score: 9, reason: "Concrete regression" })) } };
      },
    };
    const result = await new ReviewWorkload({
      snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
      deterministic: makeDeterministicStage(), persistence: new TestPersistence(),
      reportLanguage: "en-US", publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    expect(result.report.findings).toHaveLength(3);
    expect(result.report.findings.map(f => f.id)).toEqual(expect.arrayContaining(["timer", "parser"]));
    expect(result.report.duplicates).toHaveLength(1);
    expect(result.report.filteredFindingCount).toBeUndefined();
  });

  it("retains low-score filtering and per-file caps after summary parsing fails", async () => {
    const repo = makeFixtureRepo();
    const candidates = ["credential", "timer", "parser", "buffer", "lock"].map((topic, index) => ({
      ...finding(`candidate_${index}`),
      title: topic,
      evidence: ["Secret leaks through public output", "Cancellation leaves scheduled callbacks active", "Empty values bypass validation", "Oversized allocation exhausts available memory", "Concurrent writes deadlock waiting threads"][index]!,
      trigger: topic, tags: [`rule:${topic}`],
    }));
    const inner = new TestModelDriver({ findingsByAgent: { Security: candidates.slice(0, 3), Correctness: candidates.slice(3).map(f => ({ ...f, agent: "Correctness" as const })) } });
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: async () => {
        throw Object.assign(new Error("invalid summary scores"), { findingScores: [{ id: "candidate_0", score: 1, reason: "Below floor" }] });
      },
    };
    const result = await new ReviewWorkload({
      snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
      deterministic: makeDeterministicStage(), persistence: new TestPersistence(), reportLanguage: "en-US",
      publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    expect(result.report.coverage?.outcome).toBe("degraded");
    expect(result.report.findings).toHaveLength(3);
    expect(result.report.findings.map(f => f.id)).not.toContain("candidate_0");
    expect(result.report.filteredFindingCount).toBe(2);
  });

  it("does not reuse stale canonical counts on summary failure or imply a clean degraded review", async () => {
    const repo = makeFixtureRepo();
    const inner = new TestModelDriver();
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: request => inner.invokeAgentFindings(request),
      invokeSummary: async () => { throw new Error("summary unavailable"); },
    };
    const stage = makeDeterministicStage();
    stage.composeReview = async () => ({ id: "req_counts", ok: true, overallScore: 80, riskLevel: "low", summary: "Unsafe input needs validation.", recommendations: ["Reject unsafe input."] });
    const result = await new ReviewWorkload({
      snapshot: repo.snapshot, context: repo.context, modelDriver: driver,
      deterministic: stage, persistence: new TestPersistence(), reportLanguage: "en-US",
      publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    expect(result.report.summary).toMatch(/^Review coverage incomplete/);
    expect(result.report.summary).toContain("0 main-list findings");
    expect(result.report.summary).toContain("Reject unsafe input.");
    expect(result.report.summary).not.toContain("99 issues");
  });
});
