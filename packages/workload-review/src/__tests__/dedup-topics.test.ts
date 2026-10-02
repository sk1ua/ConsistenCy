import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { deduplicateAndSortFindings } from "../synthesis/report.js";

function finding(id: string, title: string, evidence: string, trigger?: string): ReviewFinding {
  return { id, title, evidence, trigger, agent: "Correctness", severity: "high", confidence: "likely",
    file: "prepare.sh", startLine: 244, endLine: 249, reasoning: evidence, recommendation: "Fix the failing behavior." };
}

describe("prose topic deduplication", () => {
  it("merges differently worded duplicates at 3/7 keyword overlap despite paraphrased triggers", () => {
    const a = finding("a", "Unchecked query injection permits attackers", "Unchecked query injection permits attackers", "Remote clients submit malicious SQL fragments");
    const b = finding("b", "Unchecked query injection allows exploits", "Unchecked query injection allows exploits", "Untrusted parameters reach concatenated database statements");
    const result = deduplicateAndSortFindings([a, b], true);
    expect(result.findings).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
  });

  it("merges a shared identifier only with the same explicit category", () => {
    const a = { ...finding("a", "SQL concatenation", "`executeQuery` accepts unsafe query fragments"), tags: ["category:injection"] };
    const b = { ...finding("b", "Parameter escaping absent", "Attacker controlled arguments reach `executeQuery`"), tags: ["category:injection"], startLine: 252, endLine: 252 };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(1);
    expect(deduplicateAndSortFindings([a, { ...b, tags: ["category:resource-leak"] }], true).findings).toHaveLength(2);
  });

  it("does not treat a shared quoted path as a code identifier", () => {
    const a = { ...finding("a", "Authentication bypass", "`src/shared.py` permits anonymous requests"), tags: ["category:security"] };
    const b = { ...finding("b", "Credential disclosure", "`src/shared.py` writes secret tokens to logs"), tags: ["category:security"] };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("does not merge the same prose at remote line ranges", () => {
    const a = finding("a", "Unchecked query injection", "Unchecked query injection");
    expect(deduplicateAndSortFindings([a, { ...a, id: "b", startLine: 300, endLine: 302 }], true).findings).toHaveLength(2);
  });

  it("does not merge adjacent lines describing unrelated failures", () => {
    const a = finding("a", "Credential disclosed", "Public logs contain secret access tokens");
    const b = { ...finding("b", "Timer survives cancellation", "Pending callbacks fire after the caller cancels"), startLine: 250, endLine: 250 };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });
  it("vetoes explicitly opposite input conditions", () => {
    const a = finding("a", "Parser rejects payload", "Parser rejects payload", "An empty input reaches the parser");
    const b = { ...a, id: "b", trigger: "A non-empty input reaches the parser" };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("does not merge failed dnf search with unavailable Rocky Python packages", () => {
    const search = finding("search", "dnf search will fail the prepare job", "An unsuccessful search aborts the prepare.sh job before installation.", "Amazon package search returns an unsuccessful exit status");
    const python = finding("python", "Python package unavailable on Rocky", "Rocky repositories lack the requested package; prepare.sh cannot install it.", "Rocky installation requests an unavailable Python package");
    expect(deduplicateAndSortFindings([search, python], true).findings).toHaveLength(2);
  });

  it("does not merge mycli KeyError, wrong option diagnostics, and reversed configuration priority", () => {
    const issues = [
      finding("key", "Missing connection key crashes with KeyError", "mycli/main.py accesses `c[\"connection\"]` without checking membership."),
      finding("option", "Error message names the wrong option", "mycli/main.py still displays the retired `ssl_mode` option in diagnostics."),
      finding("priority", "Configuration priority is reversed", "mycli/main.py makes file configuration override explicitly supplied command options.")
    ].map(item => ({ ...item, file: "mycli/main.py" }));
    expect(deduplicateAndSortFindings(issues, true).findings).toHaveLength(3);
  });

  it("does not let shared paths or identifiers dominate topic similarity", () => {
    const a = finding("a", "Authentication bypass", "`shared_identifier` in src/shared.py permits requests without authentication.");
    const b = finding("b", "Invalid configuration order", "`shared_identifier` in src/shared.py reverses configuration precedence.");
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("vetoes clearly different triggers even with the same explicit rule category", () => {
    const a = { ...finding("a", "Job aborts", "The job aborts.", "Amazon package search exits unsuccessfully before installation"), tags: ["rule:job-failure"] };
    const b = { ...finding("b", "Job aborts", "The job aborts.", "Rocky Python package installation encounters unavailable repositories"), tags: ["rule:job-failure"] };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("merges genuinely overlapping prose without requiring a shared evidence id", () => {
    const a = finding("a", "Unchecked query concatenation permits injection", "Unchecked query concatenation permits attacker injection.");
    const b = { ...a, id: "b", agent: "Security" as const };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(1);
  });
});
