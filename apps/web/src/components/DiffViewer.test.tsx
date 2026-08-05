import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewFinding, VcsChangedFile } from "@consistency/schema";
import { I18nProvider } from "../i18n";
import { DiffViewer } from "./DiffViewer";

const files: VcsChangedFile[] = [{
  path: "src/a.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  hunks: [{
    header: "@@ -1,3 +1,4 @@",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    content: " context\n-old\n+new\n+extra\n"
  }]
}];

const finding: ReviewFinding = {
  id: "f1",
  agent: "Security",
  title: "Injection risk",
  severity: "high",
  confidence: "confirmed",
  file: "src/a.ts",
  startLine: 2,
  endLine: 2,
  evidence: "Evidence",
  reasoning: "Reasoning",
  recommendation: "Fix it"
};

describe("DiffViewer", () => {
  it("renders changed files, hunks, and finding highlights", () => {
    const html = renderToString(<I18nProvider initialLocale="en-US"><DiffViewer files={files} findings={[finding]} /></I18nProvider>);
    expect(html).toContain("src/a.ts");
    expect(html).toContain("old");
    expect(html).toContain("new");
    expect(html).toContain("diff-row-del diff-finding diff-finding-high");
    expect(html).toContain("diff-row-add");
  });

  it("shows an empty state when there are no files", () => {
    const html = renderToString(<I18nProvider initialLocale="en-US"><DiffViewer files={[]} findings={[]} /></I18nProvider>);
    expect(html).toContain("No changes to show");
  });
});
