import { describe, expect, it } from "vitest";
import { reviewFindingSchema, type PRReviewContext, type ReviewFinding } from "@consistency/schema";
import { hasSpecificChangedCoverageTarget } from "../agents/test-coverage.js";

function context(file: string, source: string, changedLine: number): PRReviewContext {
  return {
    jobId: "coverage-language-job", source: "local_git", repositoryFullName: "test/example",
    baseSha: "base", headSha: "head", projectMetadata: {}, baseFileContents: {}, workspacePath: "unused-fixture-workspace",
    changedFiles: [{ path: file, status: "modified", additions: 1, deletions: 1, changes: 2,
      patch: `@@ -${changedLine},1 +${changedLine},1 @@\n-    old behavior\n+${source.split("\n")[changedLine - 1]}` }],
    diff: "", fileContents: { [file]: source }
  };
}

function gap(file: string, name: string, startLine: number, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return reviewFindingSchema.parse({
    id: "coverage-language", agent: "Test", title: `Missing null-input coverage for ${name}`,
    severity: "medium", confidence: "likely", file, startLine, endLine: startLine,
    evidence: `The changed \`${name}\` function has no null-input regression test.`,
    reasoning: "The modified return for a null payload has no regression coverage.",
    recommendation: `Test ${name} with a null payload.`, trigger: "when payload is null", ...overrides
  });
}

const signatures = [
  { label: "Go function", file: "packet.go", source: "func decodePacket(payload []byte) []byte {\n    return payload\n}" },
  { label: "Go pointer receiver", file: "packet.go", source: "func (d *Decoder) decodePacket(payload []byte) []byte {\n    return payload\n}" },
  { label: "Go value receiver", file: "packet.go", source: "func (d Decoder) decodePacket(payload []byte) []byte {\n    return payload\n}" },
  { label: "Go multiline receiver and named results", file: "packet.go", source: "func (\n    d *Decoder,\n) decodePacket(\n    payload []byte,\n) (\n    result []byte,\n) {\n    return payload\n}" },
  { label: "Go generic function with multiline parameters", file: "packet.go", source: "func decodePacket[T any](\n    payload []T,\n) []T {\n    return payload\n}" },
  { label: "Java method", file: "Packet.java", source: "public String decodePacket(String payload) {\n    return payload;\n}" },
  { label: "Java package-private method", file: "Packet.java", source: "String decodePacket(String payload) {\n    return payload;\n}" },
  { label: "Java generic method and multiline throws clause", file: "Packet.java", source: "public static <T> java.util.List<T> decodePacket(\n    java.util.List<T> payload\n) throws\n    DecodeException\n{\n    return payload;\n}" },
  { label: "Java return type and method name on separate lines", file: "Packet.java", source: "protected final\nString\ndecodePacket(\n    String payload\n) {\n    return payload;\n}" },
  { label: "Kotlin method", file: "Packet.kt", source: "fun decodePacket(payload: String?): String? {\n    return payload\n}" },
  { label: "Kotlin suspend override multiline signature", file: "Packet.kt", source: "override suspend fun decodePacket(\n    payload: String?,\n): String?\n{\n    return payload\n}" },
  { label: "Kotlin generic extension method", file: "Packet.kt", source: "private inline fun <T> Decoder<T>.decodePacket(\n    payload: T?,\n): T? {\n    return payload\n}" },
  { label: "Kotlin expression body", file: "Packet.kt", source: "fun decodePacket(payload: String?): String? = payload" },
  { label: "Kotlin multiline expression body", file: "Packet.kt", source: "fun decodePacket(\n    payload: String?,\n): String? =\n    payload" }
];

describe("Test coverage gate language declarations", () => {
  it.each(signatures)("accepts a specifically named changed $label", ({ file, source }) => {
    const lines = source.split("\n");
    const bodyLine = lines.findIndex(line => line.includes("return payload")) + 1 || lines.length;
    expect(hasSpecificChangedCoverageTarget(gap(file, "decodePacket", bodyLine), context(file, source, bodyLine))).toBe(true);
  });

  it("accepts a body finding when only a multiline method's signature changed", () => {
    const source = "public String decodePacket(\n    String payload\n) {\n    return payload;\n}";
    expect(hasSpecificChangedCoverageTarget(gap("Packet.java", "decodePacket", 4), context("Packet.java", source, 2))).toBe(true);
  });

  it.each([
    { file: "packet.go", source: "func decodePacket(payload []byte) []byte {\n    return payload\n}\nfunc other(payload []byte) []byte {\n    return payload\n}", findingLine: 2, changedLine: 5 },
    { file: "Packet.java", source: "String decodePacket(String payload) {\n    return payload;\n}\nString other(String payload) {\n    return payload;\n}", findingLine: 2, changedLine: 5 },
    { file: "Packet.kt", source: "fun decodePacket(payload: String?): String? {\n    return payload\n}\nfun other(payload: String?): String? {\n    return payload\n}", findingLine: 2, changedLine: 5 }
  ])("does not borrow a changed sibling's scope in $file", ({ file, source, findingLine, changedLine }) => {
    expect(hasSpecificChangedCoverageTarget(gap(file, "decodePacket", findingLine), context(file, source, changedLine))).toBe(false);
    expect(hasSpecificChangedCoverageTarget(gap(file, "decodePacket", changedLine), context(file, source, changedLine))).toBe(false);
  });

  it.each([
    { file: "Packet.java", source: "abstract String decodePacket(\n    String payload\n);\nString other(String payload) {\n    return payload;\n}", line: 1 },
    { file: "Packet.java", source: "return decodePacket(\n    payload\n);", line: 1 },
    { file: "Packet.kt", source: "val result = decodePacket(\n    payload\n)", line: 1 }
  ])("rejects declarations without implementations and call sites in $file", ({ file, source, line }) => {
    expect(hasSpecificChangedCoverageTarget(gap(file, "decodePacket", line), context(file, source, line))).toBe(false);
  });

  it("still rejects generic scenarios and unknown method names", () => {
    const source = "func (d *Decoder) decodePacket(payload []byte) []byte {\n    return payload\n}";
    const ctx = context("packet.go", source, 2);
    expect(hasSpecificChangedCoverageTarget(gap("packet.go", "decodePacket", 2, { trigger: "when this function is called" }), ctx)).toBe(false);
    expect(hasSpecificChangedCoverageTarget(gap("packet.go", "unknownPacket", 2), ctx)).toBe(false);
    expect(hasSpecificChangedCoverageTarget(gap("packet.go", "decodePacket", 2, { baselineAssessment: {
      behaviorUnchanged: true, baseStartLine: 2, baseEndLine: 2, reason: "Unchanged behavior."
    } }), ctx)).toBe(false);
  });
});
