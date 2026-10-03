import { describe, expect, it, vi } from "vitest";
import { resolveCompactContext, resolveLeanConsistencyStrict, resolveLeanEnabled, resolveLeanGeneralist, resolveLeanReviewer, resolveLeanMaintFilter, resolveLeanSecondSample, resolveLeanStrictMerge, resolveLeanVote, resolveRangeReadFromGit, resolveReportWithheld, resolveMemoryEnabled, resolveScoreRubricV2 } from "./config";

describe("CLI persisted memory resolution", () => {
  it("preserves memory by default", () => {
    expect(resolveMemoryEnabled({}, {})).toBe(true);
    expect(resolveMemoryEnabled({ noMemory: false }, {})).toBe(true);
  });

  it("always honors --no-memory, including when the environment says 0", () => {
    expect(resolveMemoryEnabled({ noMemory: true }, {})).toBe(false);
    expect(resolveMemoryEnabled({ noMemory: true }, { CONSISTENCY_NO_MEMORY: "0" })).toBe(false);
  });

  it("disables memory for CONSISTENCY_NO_MEMORY=1 without a CLI flag", () => {
    expect(resolveMemoryEnabled({}, { CONSISTENCY_NO_MEMORY: "1" })).toBe(false);
    expect(resolveMemoryEnabled({ noMemory: false }, { CONSISTENCY_NO_MEMORY: "1" })).toBe(false);
  });

  it.each(["0", "", "true", "false", "01"])("keeps the full review for lean env value %j", value => {
    expect(resolveLeanEnabled({ CONSISTENCY_LEAN: value })).toBe(false);
  });

  it("enables lean review only for the exact env value 1", () => {
    expect(resolveLeanEnabled({})).toBe(false);
    expect(resolveLeanEnabled({ CONSISTENCY_LEAN: "1" })).toBe(true);
  });

  it("enables the lean maintainer reviewer only for the exact env value 1", () => {
    expect(resolveLeanReviewer({})).toBe(false);
    expect(resolveLeanReviewer({ CONSISTENCY_LEAN_REVIEWER: "1" })).toBe(true);
  });

  it("parses the lean second-sample list and warns once for unknown names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveLeanSecondSample({})).toEqual([]);
    expect(resolveLeanSecondSample({ CONSISTENCY_LEAN_SECOND_SAMPLE: "" })).toEqual([]);
    expect(resolveLeanSecondSample({ CONSISTENCY_LEAN_SECOND_SAMPLE: "Maintainability,Correctness" })).toEqual(["Maintainability", "Correctness"]);
    expect(resolveLeanSecondSample({ CONSISTENCY_LEAN_SECOND_SAMPLE: "Maintainability, Style, Maintainability,Correctness" })).toEqual(["Maintainability", "Correctness"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("enables the lean Maintainability filter only for the exact env value 1", () => {
    expect(resolveLeanMaintFilter({})).toBe(false);
    expect(resolveLeanMaintFilter({ CONSISTENCY_LEAN_MAINT_FILTER: "1" })).toBe(true);
    expect(resolveLeanMaintFilter({ CONSISTENCY_LEAN_MAINT_FILTER: "true" })).toBe(false);
  });

  it("enables the lean generalist and vote only for the exact env value 1", () => {
    expect(resolveLeanGeneralist({})).toBe(false);
    expect(resolveLeanGeneralist({ CONSISTENCY_LEAN_GENERALIST: "1" })).toBe(true);
    expect(resolveLeanGeneralist({ CONSISTENCY_LEAN_GENERALIST: "true" })).toBe(false);
    expect(resolveLeanGeneralist({ CONSISTENCY_LEAN_GENERALIST: "0" })).toBe(false);
    expect(resolveLeanGeneralist({ CONSISTENCY_LEAN_GENERALIST: "" })).toBe(false);
    expect(resolveLeanVote({})).toBe(false);
    expect(resolveLeanVote({ CONSISTENCY_LEAN_VOTE: "1" })).toBe(true);
    expect(resolveLeanVote({ CONSISTENCY_LEAN_VOTE: "true" })).toBe(false);
    expect(resolveLeanVote({ CONSISTENCY_LEAN_VOTE: "0" })).toBe(false);
    expect(resolveLeanVote({ CONSISTENCY_LEAN_VOTE: "" })).toBe(false);
  });

  it("reads range head files from git only for the exact env value 1", () => {
    expect(resolveRangeReadFromGit({})).toBe(false);
    expect(resolveRangeReadFromGit({ CONSISTENCY_RANGE_READ_FROM_GIT: "1" })).toBe(true);
    expect(resolveRangeReadFromGit({ CONSISTENCY_RANGE_READ_FROM_GIT: "true" })).toBe(false);
    expect(resolveRangeReadFromGit({ CONSISTENCY_RANGE_READ_FROM_GIT: "0" })).toBe(false);
    expect(resolveRangeReadFromGit({ CONSISTENCY_RANGE_READ_FROM_GIT: "" })).toBe(false);
  });

  it("records withheld findings only for the exact env value 1", () => {
    expect(resolveReportWithheld({})).toBe(false);
    expect(resolveReportWithheld({ CONSISTENCY_REPORT_WITHHELD: "1" })).toBe(true);
    expect(resolveReportWithheld({ CONSISTENCY_REPORT_WITHHELD: "true" })).toBe(false);
  });

  it.each(["0", "", "true", "false", "01", " 1"])("keeps the lean maintainer reviewer off for env value %j", value => {
    expect(resolveLeanReviewer({ CONSISTENCY_LEAN_REVIEWER: value })).toBe(false);
  });

  it("enables compact context only for the exact env value 1", () => {
    expect(resolveCompactContext({})).toBe(false);
    expect(resolveCompactContext({ CONSISTENCY_COMPACT_CONTEXT: "0" })).toBe(false);
    expect(resolveCompactContext({ CONSISTENCY_COMPACT_CONTEXT: "1" })).toBe(true);
  });

  it("enables strict lean Consistency only for the exact env value 1", () => {
    expect(resolveLeanConsistencyStrict({})).toBe(false);
    expect(resolveLeanConsistencyStrict({ CONSISTENCY_LEAN_CONSISTENCY_STRICT: "0" })).toBe(false);
    expect(resolveLeanConsistencyStrict({ CONSISTENCY_LEAN_CONSISTENCY_STRICT: "1" })).toBe(true);
  });

  it("enables strict lean merge only for the exact env value 1", () => {
    expect(resolveLeanStrictMerge({})).toBe(false);
    expect(resolveLeanStrictMerge({ CONSISTENCY_LEAN_STRICT_MERGE: "0" })).toBe(false);
    expect(resolveLeanStrictMerge({ CONSISTENCY_LEAN_STRICT_MERGE: "1" })).toBe(true);
  });

  it("enables the v2 scoring rubric only for the exact env value 1", () => {
    expect(resolveScoreRubricV2({})).toBe(false);
    expect(resolveScoreRubricV2({ CONSISTENCY_SCORE_RUBRIC: "0" })).toBe(false);
    expect(resolveScoreRubricV2({ CONSISTENCY_SCORE_RUBRIC: "1" })).toBe(true);
  });

  it.each(["0", "", "true", "false", "01"])("keeps memory enabled for env value %j", value => {
    expect(resolveMemoryEnabled({}, { CONSISTENCY_NO_MEMORY: value })).toBe(true);
  });
});
