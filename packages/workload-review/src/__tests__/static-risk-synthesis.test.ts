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
    file("a-clean.ts", 0, "Stable"), file("b-added.ts", 0, "No Baseline"),
    file("c-skipped.ts", 0, "skipped"), file("z-danger.ts", 0.9, "Severe Drift"),
  ] });
  const result = await new ReviewWorkload({
    context: repo.context, snapshot: repo.snapshot, deterministic: stage,
    modelDriver: new TestModelDriver(), persistence: new TestPersistence(), reportLanguage: "en-US",
    publicationPolicy: "disabled", accessMode: "local_git",
  }).run();
  expect(result.report.staticRiskLabel).toBe("Severe Drift / No Baseline / skipped");
});
