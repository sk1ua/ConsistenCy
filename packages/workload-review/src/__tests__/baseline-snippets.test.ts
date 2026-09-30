import { describe, expect, it } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { buildBaselineSnippets, BASELINE_SNIPPETS_MAX_CHARS } from "../agents/baseline-snippets.js";

function context(entries: Array<{ path: string; patch?: string; content: string }>): PRReviewContext {
  return { jobId: "baseline-test", source: "local_git", repositoryFullName: "fixture", baseSha: "base", headSha: "head",
    changedFiles: entries.map(({ path, patch }) => ({ path, patch, status: "modified", additions: 1, deletions: 1, changes: 2 })),
    baseFileContents: Object.fromEntries(entries.map(({ path, content }) => [path, content])),
    fileContents: {}, projectMetadata: {}, workspacePath: ".", diff: "" };
}

describe("baseline hunk snippets", () => {
  it("uses old-side line numbers, preserves ±40 neighborhoods and merges overlapping windows", () => {
    const content = Array.from({ length: 300 }, (_, i) => `baseline_line_${i + 1}`).join("\n");
    const rendered = buildBaselineSnippets(context([{ path: "a.py", content, patch: "@@ -100,2 +150,3 @@\n-old\n+new\n@@ -130 +181 @@\n-old\n+new" }]));
    expect(rendered).toContain("60: baseline_line_60");
    expect(rendered).toContain("170: baseline_line_170");
    expect(rendered).not.toContain("59: baseline_line_59");
    expect(rendered).not.toContain("171: baseline_line_171");
    expect(rendered.match(/100: baseline_line_100/g)).toHaveLength(1);
    expect(rendered).toContain("other baseline lines omitted");
  });

  it("budgets all files fairly and explicitly marks truncated snippets without slicing lines", () => {
    const content = Array.from({ length: 120 }, (_, i) => `${i}: ${"x".repeat(1000)}`).join("\n");
    const rendered = buildBaselineSnippets(context(["a.py", "b.py", "c.py"].map(path => ({ path, content, patch: "@@ -60 +60 @@" }))));
    for (const path of ["a.py", "b.py", "c.py"]) expect(rendered).toContain(`BASE FILE ${path}`);
    expect(rendered.match(/truncated by per-file character budget/g)).toHaveLength(3);
    expect(rendered.length).toBeLessThan(BASELINE_SNIPPETS_MAX_CHARS + 1000);
  });

  it("does not invent hunk locations or attach full files when a patch is absent", () => {
    const rendered = buildBaselineSnippets(context([{ path: "a.py", content: "must_not_be_attached" }]));
    expect(rendered).toContain("no usable old-side diff hunk");
    expect(rendered).not.toContain("must_not_be_attached");
  });
});
