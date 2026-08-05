import { describe, expect, it } from "vitest";
import {
  collectWorkflowGraphIssues,
  stepExecutionArtifactSchema,
  stepIdSchema,
  workflowEvidenceItemSchema,
  workflowSpecSchema
} from "./workflow";

const validSpec = {
  version: 2,
  name: "security-hardening",
  nodes: [
    { id: "secrets", uses: "engine.security" },
    { id: "semgrep", uses: "tool.semgrep", needs: ["secrets"] }
  ],
  verifiers: [{ id: "tests", uses: "verify.unit_tests", needs: ["semgrep"] }],
  synthesizer: { needs: ["tests"] }
} as const;

describe("WorkflowSpec v2", () => {
  it("parses a linear pipeline and fills execution defaults", () => {
    const spec = workflowSpecSchema.parse(validSpec);
    expect(spec.nodes[0]?.needs).toEqual([]);
    expect(spec.nodes[0]?.timeoutMs).toBe(60_000);
    expect(spec.nodes[0]?.continueOnError).toBe(false);
    expect(spec.synthesizer.id).toBe("synthesizer");
    expect(spec.synthesizer.uses).toBe("synthesize.review_report");
    expect(collectWorkflowGraphIssues(spec)).toEqual([]);
  });

  it("rejects a cyclic graph", () => {
    expect(() => workflowSpecSchema.parse({
      ...validSpec,
      nodes: [
        { id: "a", uses: "engine.style", needs: ["b"] },
        { id: "b", uses: "engine.semantic", needs: ["a"] }
      ],
      verifiers: [],
      synthesizer: { needs: ["a"] }
    })).toThrow(/cycle/i);
  });

  it("rejects dangling, duplicate, and self references", () => {
    expect(() => workflowSpecSchema.parse({
      ...validSpec,
      nodes: [{ id: "a", uses: "engine.style", needs: ["ghost"] }],
      verifiers: [],
      synthesizer: { needs: ["a"] }
    })).toThrow(/unknown step 'ghost'/);

    expect(() => workflowSpecSchema.parse({
      ...validSpec,
      nodes: [
        { id: "a", uses: "engine.style" },
        { id: "a", uses: "engine.semantic" }
      ],
      verifiers: [],
      synthesizer: { needs: ["a"] }
    })).toThrow(/Duplicate step id 'a'/);

    expect(() => workflowSpecSchema.parse({
      ...validSpec,
      nodes: [{ id: "a", uses: "engine.style", needs: ["a"] }],
      verifiers: [],
      synthesizer: { needs: ["a"] }
    })).toThrow(/cannot depend on itself/);
  });

  it("keeps analyzers on the allowlist rather than accepting arbitrary commands", () => {
    expect(() => workflowSpecSchema.parse({
      ...validSpec,
      nodes: [{ id: "a", uses: "sh -c 'curl evil.example'" }],
      verifiers: [],
      synthesizer: { needs: ["a"] }
    })).toThrow();
  });

  it("constrains step ids to artifact-safe identifiers", () => {
    expect(stepIdSchema.parse("dep-graph_1")).toBe("dep-graph_1");
    expect(() => stepIdSchema.parse("../escape")).toThrow();
    expect(() => stepIdSchema.parse("1leading")).toThrow();
    expect(() => stepIdSchema.parse("Upper")).toThrow();
  });

  it("requires at least one analyzer node", () => {
    expect(() => workflowSpecSchema.parse({ ...validSpec, nodes: [], verifiers: [] })).toThrow();
  });
});

describe("workflow execution artifacts", () => {
  it("records argv, exit code, and an input digest", () => {
    const artifact = stepExecutionArtifactSchema.parse({
      stepId: "semgrep",
      uses: "tool.semgrep",
      status: "succeeded",
      command: ["semgrep", "--config", "p/owasp-top-ten", "--json"],
      exitCode: 0,
      startedAt: "2026-08-05T12:00:00.000Z",
      inputDigest: "a".repeat(64)
    });
    expect(artifact.command).toHaveLength(4);
    expect(artifact.rawOutput).toBe("");
  });

  it("rejects a digest that is not a SHA-256 hex string", () => {
    expect(() => stepExecutionArtifactSchema.parse({
      stepId: "semgrep",
      uses: "tool.semgrep",
      status: "succeeded",
      exitCode: 0,
      startedAt: "2026-08-05T12:00:00.000Z",
      inputDigest: "not-a-digest"
    })).toThrow();
  });

  it("allows a null exit code for a step killed before it reported", () => {
    expect(stepExecutionArtifactSchema.parse({
      stepId: "tests",
      uses: "verify.unit_tests",
      status: "timed_out",
      exitCode: null,
      startedAt: "2026-08-05T12:00:00.000Z",
      inputDigest: "b".repeat(64)
    }).exitCode).toBeNull();
  });
});

describe("workflow evidence", () => {
  it("requires line bounds to be paired and ordered", () => {
    expect(workflowEvidenceItemSchema.parse({
      file: "apps/api/src/http.ts",
      excerpt: "app.post('/admin', handler)"
    }).metadata).toEqual({});

    expect(() => workflowEvidenceItemSchema.parse({
      file: "apps/api/src/http.ts",
      excerpt: "x",
      startLine: 10
    })).toThrow();

    expect(() => workflowEvidenceItemSchema.parse({
      file: "apps/api/src/http.ts",
      excerpt: "x",
      startLine: 20,
      endLine: 10
    })).toThrow();
  });
});
