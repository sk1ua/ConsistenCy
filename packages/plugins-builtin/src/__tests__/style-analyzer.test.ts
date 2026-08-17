/**
 * StyleAnalyzer tests — AC-STYLE-1 … AC-STYLE-5.
 */

import { describe, it, expect } from "vitest";
import { computeEvidenceFingerprint } from "@consistency/kernel";
import {
  DEFAULT_STYLE_CONFIG,
  STYLE_ANALYZER_VERSION,
  StyleAnalyzer,
  TreeSitterService,
  type AnalyzerDeps,
  type AnalyzerInput,
} from "../index.js";

function makeDeps(files: Record<string, string>): AnalyzerDeps {
  return {
    readFile: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`missing fixture file ${path}`);
      return { path, content };
    },
    treeSitter: new TreeSitterService(),
  };
}

function makeInput(files: Record<string, string>): AnalyzerInput {
  return {
    repository: "test/example",
    headSha: "abc123def456",
    files: Object.keys(files).sort(),
  };
}

const analyzer = new StyleAnalyzer();

describe("StyleAnalyzer — deterministic style evidence", () => {
  it("AC-STYLE-1: clean fixture emits no false evidence for tested rules", async () => {
    const files = {
      "src/clean.ts": [
        "const x = 1;",
        "function small(a: number): number {",
        "  return a;",
        "}",
        "// TODO(PROJ-123) tracked ticket form is fine",
      ].join("\n"),
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    expect(evidence).toEqual([]);
  });

  it("AC-STYLE-2: known violations emit expected rule + location", async () => {
    const longLine = "// " + "x".repeat(115); // 118 chars — over default 100
    const files = {
      "src/violations.ts": [
        "function trailing(): void {  ", // trailing whitespace
        longLine, // line-too-long
        "// TODO fix this someday", // forbidden-todo (no ticket)
        "function f(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}", // 6 params
      ].join("\n"),
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));

    expect(evidence.map((e) => ({ rule: e.ruleId, line: e.location.startLine }))).toEqual([
      { rule: "style.trailing-whitespace", line: 1 },
      { rule: "style.line-too-long", line: 2 },
      { rule: "style.forbidden-todo", line: 3 },
      { rule: "style.too-many-parameters", line: 4 },
    ]);
    // The AST rule reports the full parameter-list span (single line here).
    expect(evidence[3]!.location.endLine).toBe(4);
    expect(evidence[3]!.source).toBe("ast");
  });

  it("AC-STYLE-3: output order is deterministic across files and lines", async () => {
    const files = {
      "src/b.ts": "const b = 1;  \n".repeat(1) + "function ok() {}\n",
      "src/a.ts": "const a = 1;\nconst c = 2;  \n",
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    const order = evidence.map((e) => `${e.location.path}:${e.location.startLine}`);
    expect(order).toEqual([...order].sort());
    // Cross-file ordering: a.ts evidence comes before b.ts evidence.
    expect(evidence[0]!.location.path).toBe("src/a.ts");
    expect(evidence[0]!.location.startLine).toBe(2);
    expect(evidence[1]!.location.path).toBe("src/b.ts");
    expect(evidence[1]!.location.startLine).toBe(1);
  });

  it("AC-STYLE-4: analyzing the same snapshot twice yields identical fingerprints", async () => {
    const files = {
      "src/mix.ts": [
        "const x = 1;  ",
        "// TODO untracked",
        "function g(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number, a7: number) {}",
      ].join("\n"),
    };
    const input = makeInput(files);
    const deps = makeDeps(files);

    const run1 = await analyzer.analyze(input, deps);
    const run2 = await analyzer.analyze(input, deps);

    expect(run1.map(computeEvidenceFingerprint)).toEqual(run2.map(computeEvidenceFingerprint));
    expect(run1.map(computeEvidenceFingerprint).length).toBeGreaterThan(0);
  });

  it("AC-STYLE-5: evidence provenance carries the correct SHA / analyzer / version", async () => {
    const files = { "src/x.ts": "const x = 1;  \n" };
    const input = makeInput(files);
    const evidence = await analyzer.analyze(input, makeDeps(files));

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.provenance).toEqual({
      repository: "test/example",
      sha: "abc123def456",
      analyzer: "style",
      analyzerVersion: STYLE_ANALYZER_VERSION,
    });
    expect(STYLE_ANALYZER_VERSION).toBe("1.0.0");
  });

  it("configuration thresholds are honored deterministically", async () => {
    const files = { "src/cfg.ts": "const line = " + `"${"x".repeat(60)}";` + "\n" };
    const input = makeInput(files);
    const deps = makeDeps(files);

    const defaultRun = await analyzer.analyze(input, deps);
    expect(defaultRun).toHaveLength(0); // 70 chars < 100

    const strict = await analyzer.analyze(input, deps, { ...DEFAULT_STYLE_CONFIG, maxLineLength: 40 });
    expect(strict.map((e) => e.ruleId)).toEqual(["style.line-too-long"]);
  });

  it("red-team: excerpts never leak raw credential values found on the same line", async () => {
    const fakeToken = `ghp_${"C".repeat(36)}`; // synthetic
    const files = {
      "src/leak.ts": `export const token = "${fakeToken}";  \n`,
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));

    expect(evidence).toHaveLength(1); // trailing whitespace only
    expect(evidence[0]!.ruleId).toBe("style.trailing-whitespace");
    expect(JSON.stringify(evidence[0])).not.toContain(fakeToken);
    expect(JSON.stringify(evidence[0])).toContain("[REDACTED]");
  });
});
