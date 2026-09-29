import { describe, expect, it } from "vitest";
import runWorkflowResponse from "../../../tests/fixtures/run_workflow_response.json";
import {
  wireProtocolRequestSchema,
  wireRunWorkflowRequestSchema,
  wireRunWorkflowResponseSchema
} from "./protocol";
import { stepExecutionArtifactSchema, workflowRunSchema } from "./workflow";

describe("run_workflow wire protocol", () => {
  it("parses a response captured from the real Python engine", () => {
    // Regenerate with:
    //   echo '<request>' | python -m engine > tests/fixtures/run_workflow_response.json
    // If this fails, the two sides of the stdio contract have diverged.
    const parsed = wireRunWorkflowResponseSchema.parse(runWorkflowResponse);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.run.specName).toBe("architectural-drift");
    expect(parsed.run.status).toBe("succeeded");
    expect(parsed.run.artifacts.length).toBeGreaterThan(0);
  });

  it("accepts every artifact the engine emitted", () => {
    const parsed = wireRunWorkflowResponseSchema.parse(runWorkflowResponse);
    if (!parsed.ok) throw new Error("expected a successful run");

    for (const artifact of parsed.run.artifacts) {
      expect(() => stepExecutionArtifactSchema.parse(artifact)).not.toThrow();
      expect(artifact.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("carries evidence anchored to a real file", () => {
    const parsed = wireRunWorkflowResponseSchema.parse(runWorkflowResponse);
    if (!parsed.ok) throw new Error("expected a successful run");

    const items = parsed.run.artifacts.flatMap(artifact => artifact.evidence?.items ?? []);
    const cycle = items.find(item => item.rule === "graph.dependency.circular_import");
    expect(cycle).toBeDefined();
    expect(cycle?.file).toBe("pkg/alpha.py");
  });

  it("round-trips the run through the shared workflowRun schema", () => {
    const parsed = wireRunWorkflowResponseSchema.parse(runWorkflowResponse);
    if (!parsed.ok) throw new Error("expected a successful run");
    expect(() => workflowRunSchema.parse(parsed.run)).not.toThrow();
  });

  it("discriminates run_workflow within the request union", () => {
    const request = {
      id: "req_1",
      action: "run_workflow" as const,
      workflow: "security-hardening",
      files: [{ path: "a.py", content: "x = 1\n" }]
    };
    expect(wireRunWorkflowRequestSchema.parse(request).workflow).toBe("security-hardening");
    expect(wireProtocolRequestSchema.parse(request).action).toBe("run_workflow");
  });

  it("accepts an inline workflow spec alongside the name", () => {
    const request = {
      id: "req_1",
      action: "run_workflow" as const,
      workflow: "custom-check",
      spec: {
        version: 2,
        name: "custom-check",
        nodes: [{ id: "security", uses: "engine.security" }],
        verifiers: [],
        synthesizer: { needs: ["security"] }
      },
      files: [{ path: "a.py", content: "x = 1\n" }]
    };
    const parsed = wireRunWorkflowRequestSchema.parse(request);
    expect(parsed.spec?.name).toBe("custom-check");
  });

  it("rejects a request that omits the workflow name", () => {
    expect(() => wireRunWorkflowRequestSchema.parse({
      id: "req_1",
      action: "run_workflow",
      files: []
    })).toThrow();
  });

  it("rejects a failure payload that also claims a run", () => {
    expect(() => wireRunWorkflowResponseSchema.parse({
      id: "req_1",
      ok: false,
      error: "boom",
      run: {}
    })).toThrow();
  });
});
