import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { deduplicateAndSortFindings } from "../synthesis/report.js";

function finding(id: string, agent: ReviewFinding["agent"], title: string, evidence: string, trigger?: string): ReviewFinding {
  return { id, agent, title, evidence, trigger, severity: "high", confidence: "likely",
    file: "prepare.sh", startLine: 244, endLine: 249, reasoning: evidence, recommendation: "Fix the failing behavior." };
}

function rockyFindings(): [ReviewFinding, ReviewFinding] {
  return [
    finding("correctness", "Correctness", "rockylinux cannot supply python3.12", "rockylinux repositories omit python3.12", "The prepare job runs on rockylinux"),
    finding("architecture", "ArchitectureAuditor", "Installation stops for an unsupported runtime", "Requesting python3.12 via rockylinux dnf aborts setup", "The prepare job runs on rockylinux")
  ];
}

function frameFindings(): [ReviewFinding, ReviewFinding] {
  return [
    { ...finding("correctness", "Correctness", "Control packets escape to consumers", "`FrameProcessor` forwards `RequestFrame` out of `ServiceSwitcher`.", "A service-switch request reaches the processor"),
      file: "service_switcher.py", startLine: 233, endLine: 238, tags: ["category:correctness"] },
    { ...finding("architecture", "ArchitectureAuditor", "Internal routing messages breach the boundary", "`ServiceSwitcher` exposes `RequestFrame` through `FrameProcessor`.", "A service-switch request reaches the processor"),
      file: "service_switcher.py", startLine: 238, endLine: 242, tags: ["category:architecture"] }
  ];
}

describe("cross-expert identifier deduplication", () => {
  it("merges overlapping unquoted rockylinux/python3.12 reports without category tags", () => {
    const [a, b] = rockyFindings();
    const result = deduplicateAndSortFindings([a, b], true);
    expect(result.findings).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(new Set([result.findings[0]!.agent, ...result.findings[0]!.alsoReportedBy!])).toEqual(new Set(["Correctness", "ArchitectureAuditor"]));
    expect(result.findings[0]!.mergedFindings).toHaveLength(1);
  });

  it("recognizes case variants of runtime and distribution proper nouns", () => {
    const [a, b] = rockyFindings();
    expect(deduplicateAndSortFindings([a, { ...b, evidence: "Requesting Python3.12 via ROCKYLINUX dnf aborts setup" }], true).findings).toHaveLength(1);
  });

  it("merges the downstream request-frame leak across Correctness/Architecture categories", () => {
    const [a, b] = frameFindings();
    const result = deduplicateAndSortFindings([a, b], true);
    expect(result.findings).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.findings[0]!.alsoReportedBy).toEqual([result.duplicates[0]!.agent]);
    expect(result.findings[0]!.mergedFindings).toEqual([expect.objectContaining({ agent: result.duplicates[0]!.agent, title: result.duplicates[0]!.title })]);
  });

  it("keeps mycli main.py:183 invalid-old-value and empty-string-old-value triggers separate", () => {
    const a = { ...finding("invalid", "Correctness", "Old values fall through to the new key", "`old_value` is replaced through `new_key`.", "An invalid old value is overwritten by a new value"),
      file: "mycli/main.py", startLine: 183, endLine: 183, tags: ["category:correctness"] };
    const b = { ...finding("empty", "ArchitectureAuditor", "Old values fall through to the new key", "`old_value` is replaced through `new_key`.", "An empty-string old value falls through to the new key"),
      file: "mycli/main.py", startLine: 183, endLine: 183, tags: ["category:architecture"] };
    const result = deduplicateAndSortFindings([a, b], true);
    expect(result.findings.map(item => item.id)).toEqual(["invalid", "empty"]);
    expect(result.findings.map(item => item.trigger)).toEqual([a.trigger, b.trigger]);
    expect(result.duplicates).toHaveLength(0);
  });

  it("does not merge shared frame classes with explicitly different trigger conditions", () => {
    const [a, b] = frameFindings();
    const result = deduplicateAndSortFindings([
      { ...a, trigger: "An empty input reaches the processor" },
      { ...b, trigger: "A non-empty input reaches the processor" }
    ], true);
    expect(result.findings).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });

  it("recognizes rockylinux as a distinct distribution trigger", () => {
    const [a, b] = frameFindings();
    const result = deduplicateAndSortFindings([
      { ...a, trigger: "An Amazon deployment routes a service-switch request" },
      { ...b, trigger: "A rockylinux deployment routes a service-switch request" }
    ], true);
    expect(result.findings).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });

  it.each([
    { description: "adjacent", startLine: 250, endLine: 252 },
    { description: "nearby", startLine: 252, endLine: 253 },
    { description: "remote", startLine: 300, endLine: 302 }
  ])("does not use identifiers alone to merge $description, non-overlapping ranges", ({ startLine, endLine }) => {
    const [a, b] = rockyFindings();
    expect(deduplicateAndSortFindings([a, { ...b, startLine, endLine }], true).findings).toHaveLength(2);
  });

  it("does not merge the same technical targets in different files", () => {
    const [a, b] = rockyFindings();
    expect(deduplicateAndSortFindings([a, { ...b, file: "install.sh" }], true).findings).toHaveLength(2);
  });

  it("requires more than one shared technical target when categories differ", () => {
    const a = { ...finding("a", "Correctness", "Control packets escape", "`RequestFrame` reaches external consumers."), tags: ["category:correctness"] };
    const b = { ...finding("b", "ArchitectureAuditor", "Internal routing crosses a boundary", "An internal message exposes `RequestFrame`."), tags: ["category:architecture"] };
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("does not split runtime versions into additional shared identifiers", () => {
    const a = finding("a", "Correctness", "Repositories omit the selected runtime", "`rockylinux` cannot supply `python3.12`.");
    const b = finding("b", "ArchitectureAuditor", "Setup requests an unsupported package", "Installing `python3.13` via `rockylinux` dnf aborts setup.");
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("keeps unquoted camelCase runtime versions whole", () => {
    const a = finding("a", "Correctness", "Repositories omit the selected runtime", "rockylinux cannot supply OpenSSL3.0.");
    const b = finding("b", "ArchitectureAuditor", "Setup requests an unsupported package", "Installing OpenSSL3.1 via rockylinux dnf aborts setup.");
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("does not count shared quoted paths as technical targets", () => {
    const a = finding("a", "Correctness", "Authentication bypass", "`config/rockylinux` and `bin/python3.12` permit anonymous requests.");
    const b = finding("b", "ArchitectureAuditor", "Configuration order reversed", "`config/rockylinux` and `bin/python3.12` reverse option precedence.");
    expect(deduplicateAndSortFindings([a, b], true).findings).toHaveLength(2);
  });

  it("does not apply category-free target matching to unlocated findings", () => {
    const [a, b] = rockyFindings();
    expect(deduplicateAndSortFindings([a, { ...b, confidence: "likely", startLine: undefined, endLine: undefined }], true).findings).toHaveLength(2);
  });
});
