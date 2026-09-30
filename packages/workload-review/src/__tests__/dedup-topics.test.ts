import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { deduplicateAndSortFindings } from "../synthesis/report.js";

function finding(id: string, title: string, evidence: string, trigger?: string): ReviewFinding {
  return { id, title, evidence, trigger, agent: "Correctness", severity: "high", confidence: "likely",
    file: "prepare.sh", startLine: 244, endLine: 249, reasoning: evidence, recommendation: "Fix the failing behavior." };
}

describe("prose topic deduplication", () => {
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
