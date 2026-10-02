import { describe, expect, it } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { buildBaselineSnippets, BASELINE_SNIPPETS_MAX_CHARS } from "../agents/baseline-snippets.js";
import { buildAgentPrompt } from "../agents/prompts.js";

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

  it("charges all file headers, range headers and notices against the strict global budget", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      path: `src/module_${index}_${"long_path".repeat(4)}.py`,
      content: Array.from({ length: 120 }, (_, line) => `line_${line + 1}: ${"x".repeat(300)}`).join("\n"),
      patch: "@@ -60 +60 @@",
    }));
    const rendered = buildBaselineSnippets(context(entries));
    expect(rendered.length).toBeLessThanOrEqual(BASELINE_SNIPPETS_MAX_CHARS);
    expect(rendered).toContain("global character budget");
    expect(rendered).toContain("omitted code is unknown");
    expect(buildBaselineSnippets(context(entries), 500).length).toBeLessThanOrEqual(500);
  });

  it("retains both edit centers before distant padding when multiple hunk neighborhoods exceed the budget", () => {
    const content = Array.from({ length: 600 }, (_, index) => `line_${index + 1}: ${"x".repeat(200)}`).join("\n");
    const rendered = buildBaselineSnippets(context([{ path: "a.py", content, patch: "@@ -100 +100 @@\n@@ -500 +500 @@" }]));
    expect(rendered).toContain("100: line_100:");
    expect(rendered).toContain("500: line_500:");
    expect(rendered).not.toContain("60: line_60:");
    expect(rendered).not.toContain("460: line_460:");
    expect(rendered).not.toContain("540: line_540:");
    expect(rendered.length).toBeLessThanOrEqual(BASELINE_SNIPPETS_MAX_CHARS);
  });

  it("prioritizes actual old-side deletions over the beginning of a context-heavy hunk", () => {
    const content = Array.from({ length: 150 }, (_, index) => `line_${index + 1}: ${"x".repeat(200)}`).join("\n");
    const patch = ["@@ -50,21 +50,21 @@", ...Array(10).fill(" context"), "-removed", "+replacement", ...Array(10).fill(" context")].join("\n");
    const rendered = buildBaselineSnippets(context([{ path: "a.py", content, patch }]), 1_500);
    expect(rendered).toContain("60: line_60:");
    expect(rendered).not.toContain("10: line_10:");
    expect(rendered.length).toBeLessThanOrEqual(1_500);
  });

  it("never slices an oversized source line into apparently complete baseline evidence", () => {
    const lines = Array.from({ length: 120 }, (_, index) => `line_${index + 1}`);
    lines[59] = `oversized_source_${"x".repeat(20_000)}`;
    const rendered = buildBaselineSnippets(context([{ path: "a.py", content: lines.join("\n"), patch: "@@ -60 +60 @@" }]));
    expect(rendered).not.toContain("oversized_source_");
    expect(rendered).toContain("59: line_59");
    expect(rendered).toContain("omitted code is unknown");
  });

  it("keeps baseline snippets inside the identical specialist prefix with only the role at the tail", () => {
    const fixture = context([{ path: "a.py", content: "baseline_line", patch: "@@ -1 +1 @@" }]);
    const security = buildAgentPrompt("Security", fixture, undefined, [], "en-US").userPrompt;
    const correctness = buildAgentPrompt("Correctness", fixture, undefined, [], "en-US").userPrompt;
    expect(security.split("\n\nSPECIALIST ROLE:")[0]).toBe(correctness.split("\n\nSPECIALIST ROLE:")[0]);
    expect(security).toContain("BASE FILE a.py");
    expect(security.indexOf("BASE FILE a.py")).toBeLessThan(security.indexOf("SPECIALIST ROLE: Security"));
  });

  it("does not invent hunk locations or attach full files when a patch is absent", () => {
    const rendered = buildBaselineSnippets(context([{ path: "a.py", content: "must_not_be_attached" }]));
    expect(rendered).toContain("no usable old-side diff hunk");
    expect(rendered).not.toContain("must_not_be_attached");
  });
});
