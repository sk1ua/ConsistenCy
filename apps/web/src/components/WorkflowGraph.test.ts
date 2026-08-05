import { describe, expect, it } from "vitest";
import { workflowSpecSchema } from "@consistency/schema";
import { layoutWorkflow } from "./WorkflowGraph";

describe("layoutWorkflow", () => {
  const spec = workflowSpecSchema.parse({
    version: 2,
    name: "sample",
    nodes: [
      { id: "security", uses: "engine.security" },
      { id: "structure", uses: "engine.structural", needs: ["security"] }
    ],
    verifiers: [],
    synthesizer: { needs: ["structure"] }
  });

  it("maps every step to a positioned node and every need to an edge", () => {
    const { nodes, edges } = layoutWorkflow(spec);
    expect(nodes.map(node => node.id).sort()).toEqual(["security", "structure", "synthesizer"]);
    expect(edges.map(edge => `${edge.source}->${edge.target}`)).toEqual(["security->structure", "structure->synthesizer"]);
    for (const node of nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  it("drops edges whose source step no longer exists", () => {
    const broken = {
      ...spec,
      nodes: spec.nodes.map(node => node.id === "structure"
        ? { ...node, needs: ["security", "missing"] }
        : node)
    } as typeof spec;
    const { edges } = layoutWorkflow(broken);
    expect(edges.every(edge => !edge.source.includes("missing"))).toBe(true);
  });
});
