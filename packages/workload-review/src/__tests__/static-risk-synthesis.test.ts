import { afterEach, expect, it } from "vitest";
import type { DomainFileResult } from "@consistency/schema";
import { ReviewWorkload } from "../index.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

it("synthesizes the highest-risk file label and retains baseline warnings from other files", async () => {
  const repo = makeFixtureRepo();
  const file = (path: string, riskScore: number, riskLabel: string): DomainFileResult => ({
    path, riskScore, riskLabel, riskColor: "GREEN", findings: [], confidence: 1, signals: {},
  });
  const stage = makeDeterministicStage();
  stage.analyze = async () => ({ id: "req_static", ok: true, files: [
    file("a-added.ts", 0, "No Baseline"), file("b-added.ts", 0, "No Baseline"),
    file("c-skipped.ts", 0, "No Baseline / skipped"), file("z-danger.ts", 0.9, "Severe Drift / No Baseline"),
  ] });
  // Input-only: the fixture repo has baselines. Clear them so the retained
  // whole-PR No Baseline assertion describes an all-missing analysis.
  const context = { ...repo.context, baseFileContents: {} };
  const result = await new ReviewWorkload({
    context, snapshot: repo.snapshot, deterministic: stage,
    modelDriver: new TestModelDriver(), persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git",
  }).run();
  expect(result.report.staticRiskLabel).toBe("Severe Drift / No Baseline / skipped");
});

it("names No Baseline when changed files have no baseline and analysis returns no files", async () => {
  const repo = makeFixtureRepo();
  const stage = makeDeterministicStage();
  // Input-only: an empty file list is now Not Analyzed. Supply a scored
  // all-missing file so the retained No Baseline assertion still describes
  // an analysis that actually ran.
  stage.analyze = async () => ({ id: "req_static", ok: true, files: [{
    path: "src/index.ts", riskScore: 0, riskLabel: "No Baseline", riskColor: "GREY", signals: { steps: ["style"] }, findings: [], confidence: 1,
  }] });
  const context = {
    ...repo.context,
    baseFileContents: {},
    changedFiles: repo.context.changedFiles.filter(file => file.status !== "removed"),
  };
  const result = await new ReviewWorkload({
    context, snapshot: repo.snapshot, deterministic: stage,
    modelDriver: new TestModelDriver(), persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git",
  }).run();
  expect(result.report.staticRiskLabel).toBe("No Baseline");
});

it("does not invent No Baseline for an empty analysis when every changed file has a baseline", async () => {
  const repo = makeFixtureRepo();
  const stage = makeDeterministicStage();
  // Input-only: an empty file list is Not Analyzed, not Consistent. Supply a
  // scored baselined file so the retained Consistent assertion still applies.
  stage.analyze = async () => ({ id: "req_static", ok: true, files: [{
    path: "src/index.ts", riskScore: 0, riskLabel: "Consistent", riskColor: "GREEN", signals: { steps: ["style"] }, findings: [], confidence: 1,
  }] });
  const result = await new ReviewWorkload({
    context: repo.context, snapshot: repo.snapshot, deterministic: stage,
    modelDriver: new TestModelDriver(), persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git",
  }).run();
  expect(result.report.staticRiskLabel).toBe("Consistent");
  expect(result.report.staticRiskLabel).not.toContain("No Baseline");
});

it("names Not Analyzed when the deterministic stage returns no scored files", async () => {
  const repo = makeFixtureRepo();
  const stage = makeDeterministicStage();
  stage.analyze = async () => ({ id: "req_static", ok: true, files: [] });
  const result = await new ReviewWorkload({
    context: repo.context, snapshot: repo.snapshot, deterministic: stage,
    modelDriver: new TestModelDriver(), persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git",
  }).run();
  expect(result.report.staticRiskLabel).toContain("Not Analyzed");
  expect(result.report.staticRiskLabel).toContain("no scored files");
  expect(result.report.staticRiskLabel).not.toBe("Consistent");
});

it("does not let one added changeset file mark the whole PR No Baseline", async () => {
  const repo = makeFixtureRepo();
  const stage = makeDeterministicStage();
  stage.analyze = async () => ({ id: "req_static", ok: true, files: [
    { path: "src/index.ts", riskScore: 0.4, riskLabel: "Moderate Drift", riskColor: "YELLOW", signals: { steps: ["style"] }, findings: [], confidence: 1 },
    { path: ".changeset/note.md", riskScore: 0, riskLabel: "No Baseline", riskColor: "GREY", signals: { steps: [] }, findings: [], confidence: 0 },
  ] });
  const context = {
    ...repo.context,
    changedFiles: [
      ...repo.context.changedFiles,
      { path: ".changeset/note.md", status: "added" as const, additions: 1, deletions: 0, changes: 1 },
    ],
  };
  const result = await new ReviewWorkload({
    context, snapshot: repo.snapshot, deterministic: stage,
    modelDriver: new TestModelDriver(), persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git",
  }).run();
  expect(result.report.staticRiskLabel).toContain("Moderate Drift");
  expect(result.report.staticRiskLabel).toContain("1 new file");
  expect(result.report.staticRiskLabel).not.toContain("No Baseline");
});
