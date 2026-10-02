import { afterEach, describe, expect, it } from "vitest";
import { ReviewWorkload } from "../index.js";
import { modelSummaryProse } from "../synthesis/summary-prose.js";
import { cleanupTmpDirs, makeDeterministicStage, makeFixtureRepo, securityFinding, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

describe("structured model summary", () => {
  it.each([
    ['{"summary":"  fixes two bugs  ","scores":[]}', "  fixes two bugs  "],
    ['```json\n{"summary":"Parsed JSON"}\n```', "Parsed JSON"],
    ['<review><summary>Fix &amp; preserve &#x41;.</summary></review>', "Fix & preserve A."],
    ['```xml\n<summary><![CDATA[修复了两个问题]]></summary>\n```', "修复了两个问题"],
    ['<?xml version="1.0"?><review><summary>Parsed XML</summary><score>9</score></review>', "Parsed XML"],
    ['  fixes two bugs\nno new security risk  ', '  fixes two bugs\nno new security risk  '],
  ])("extracts only safe prose from %s", (source, expected) => {
    expect(modelSummaryProse(source)).toBe(expected);
  });

  it.each([
    '{"summary":', '{"findings":[]}', '{"summary":42}', '[{"summary":"No"}]',
    '<review><summary>Broken</review>', '<review><scores>9</scores></review>',
    '<!DOCTYPE review [<!ENTITY secret SYSTEM "file:///secret">]><review><summary>&secret;</summary></review>',
    '<summary>First</summary><summary>Second</summary>', '<review><summary>&unknown;</summary></review>',
    '{"summary":"{\\\"scores\\\":[]}"}', 'Provider reply:\n{"summary":"Embedded JSON"}',
    '```json\nnot valid\n```',
  ])("rejects unparseable, missing, unsafe or still-structured content: %s", source => {
    expect(modelSummaryProse(source)).toBeUndefined();
  });

  it.each([
    { raw: '{"summary":"Extracted prose","scores":[]}', expected: "Extracted prose" },
    { raw: '<review><summary>Extracted prose</summary></review>', expected: "Extracted prose" },
    { raw: '{"summary":', expected: "Canonical summary text." },
    { raw: '<review><summary>Broken</review>', expected: "Canonical summary text." },
  ])("publishes prose or deterministic fallback, not $raw", async ({ raw, expected }) => {
    const repo = makeFixtureRepo();
    const result = await new ReviewWorkload({
      snapshot: repo.snapshot, context: repo.context,
      modelDriver: new TestModelDriver({ summary: raw, findingsByAgent: { Security: [securityFinding()] } }),
      deterministic: makeDeterministicStage(), persistence: new TestPersistence(),
      reportLanguage: "en-US", publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    expect(result.report.summary).toContain(expected);
    expect(result.report.summary).not.toContain(raw);
    expect(result.report.summary).toContain("1 main-list finding");
    expect(result.report.coverage!.outcome).toBe("complete");
  });
});
