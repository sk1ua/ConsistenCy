import { describe, expect, it } from "vitest";
import type { WorkflowRuntimeDefinition, WorkflowRuntimeNodeType } from "@consistency/schema";
import { createStudioState, layoutStudioGraph, rectangleEdgeAnchors, serializeStudioDefinition, STUDIO_NODE_HEIGHT, STUDIO_NODE_WIDTH, studioDefinitionFingerprint, studioGraphIssues, studioReducer } from "./state";

const types: WorkflowRuntimeNodeType[] = [
  { type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", role: "analyzer", description: "", capabilityRequirements: ["repo.read"], coeffects: ["admission"], parameterSchema: { fields: [{ name: "analyzers", label: "Analyzers", type: "string[]", required: false, enumValues: ["style", "secret"], default: ["style"] }] } },
  { type: "verifier.persisted-evidence", serviceRef: "persisted-evidence.verifier", role: "verifier", description: "", capabilityRequirements: ["evidence.read"], coeffects: ["admission"], parameterSchema: { fields: [] } },
];
const definition = (id = "review"): WorkflowRuntimeDefinition => ({ id, version: 1, nodes: [{ id: "verify", type: types[1]!.type, serviceRef: types[1]!.serviceRef, parameters: {}, failurePolicy: "fail-closed" }, { id: "analyze", type: types[0]!.type, serviceRef: types[0]!.serviceRef, parameters: { analyzers: ["style"] }, failurePolicy: "fail-closed" }], edges: [{ from: "analyze", to: "verify" }] });

describe("Runtime Studio state", () => {
  it("serializes nodes and edges deterministically", () => expect(serializeStudioDefinition(definition()).nodes.map(n => n.id)).toEqual(["analyze", "verify"]));
  it("adds registry nodes and connects them", () => { let state = createStudioState(definition("user-review")); state = studioReducer(state, { type: "add-node", nodeType: types[0]! }, types); expect(state.draft.nodes.length).toBe(3); const added = state.draft.nodes.find(node => node.id !== "analyze" && node.id !== "verify")!; state = studioReducer(state, { type: "connect", from: "verify", to: added.id }, types); expect(state.draft.edges.some(e => e.to === added.id)).toBe(true); });
  it("rejects self edges and unknown parameters", () => { const state = createStudioState(definition()); expect(studioReducer(state, { type: "connect", from: "verify", to: "verify" }, types).draft.edges).toHaveLength(1); expect(studioReducer(state, { type: "update-params", nodeId: "analyze", parameters: { nope: true } }, types).draft.nodes.find(n => n.id === "analyze")!.parameters).toEqual({ analyzers: ["style"] }); });
  it("removes associated edges and resets to immutable baseline", () => { let state = createStudioState(definition()); state = studioReducer(state, { type: "remove-node", nodeId: "analyze" }, types); expect(state.draft.edges).toHaveLength(0); state = studioReducer(state, { type: "reset" }, types); expect(state.draft.nodes).toHaveLength(2); expect(state.dirty).toBe(false); });
  it("reports graph invariants", () => expect(studioGraphIssues({ ...definition(), edges: [{ from: "verify", to: "missing" }] }, types)).toContain("unknown edge endpoint: verify → missing"));
  it("detects cycles, duplicate edges, and non-finite typed parameters", () => {
    const cyclic = { ...definition(), edges: [{ from: "analyze", to: "verify" }, { from: "verify", to: "analyze" }, { from: "verify", to: "analyze" }], nodes: definition().nodes.map(node => node.id === "analyze" ? { ...node, parameters: { analyzers: ["style"], extra: true } } : node) };
    const issues = studioGraphIssues(cyclic, types);
    expect(issues.some(issue => issue.includes("graph cycle"))).toBe(true);
    expect(issues).toContain("duplicate edge: verify → analyze");
    expect(issues).toContain("unknown parameter: analyze.extra");
  });
  it("fingerprints equivalent ordering identically", () => expect(studioDefinitionFingerprint(definition())).toBe(studioDefinitionFingerprint({ ...definition(), nodes: [...definition().nodes].reverse(), edges: [...definition().edges].reverse() })));
  it("disconnects reversibly and reset clears mutations", () => {
    let state = createStudioState(definition());
    state = studioReducer(state, { type: "disconnect", from: "analyze", to: "verify" }, types);
    expect(state.draft.edges).toHaveLength(0);
    state = studioReducer(state, { type: "reset" }, types);
    expect(state.draft.edges).toHaveLength(1);
  });
  it("anchors horizontal, vertical, and diagonal edges on rectangle boundaries", () => {
    const cases = [
      rectangleEdgeAnchors({ x: 90, y: 42 }, { x: 360, y: 42 }),
      rectangleEdgeAnchors({ x: 90, y: 42 }, { x: 90, y: 210 }),
      rectangleEdgeAnchors({ x: 90, y: 42 }, { x: 360, y: 210 }),
    ];
    for (const { source, target } of cases) {
      expect(Number.isFinite(source.x) && Number.isFinite(source.y)).toBe(true);
      expect(Number.isFinite(target.x) && Number.isFinite(target.y)).toBe(true);
      expect(Math.abs(source.x - 90) === STUDIO_NODE_WIDTH / 2 || Math.abs(source.y - 42) === STUDIO_NODE_HEIGHT / 2).toBe(true);
      expect(Math.abs(target.x - 360) === STUDIO_NODE_WIDTH / 2 || Math.abs(target.y - 210) === STUDIO_NODE_HEIGHT / 2 || (target.x === 360 && target.y === 42)).toBe(true);
    }
    const coincident = rectangleEdgeAnchors({ x: 90, y: 42 }, { x: 90, y: 42 });
    expect(coincident).toEqual({ source: { x: 180, y: 42 }, target: { x: 0, y: 42 } });
  });

  it("marks self-edges as cycle fallback and keeps large/fan-in layouts bounded and deterministic", () => {
    const selfCycle = layoutStudioGraph({ ...definition(), edges: [{ from: "analyze", to: "analyze" }] });
    expect(selfCycle.hasCycle).toBe(true);
    expect(selfCycle.items.map(item => item.y)).toEqual([24, 24]);
    const fanin = layoutStudioGraph({ ...definition(), nodes: [...definition().nodes, { ...definition().nodes[0]!, id: "analyze-two" }], edges: [{ from: "analyze", to: "verify" }, { from: "analyze-two", to: "verify" }] });
    expect(new Set(fanin.items.map(item => item.y)).size).toBeGreaterThan(1);
    const largeDefinition = { ...definition(), nodes: Array.from({ length: 24 }, (_, index) => ({ ...definition().nodes[0]!, id: `node-${index}` })), edges: [] };
    const large = layoutStudioGraph(largeDefinition);
    expect(large.items.every(item => item.x >= 0 && item.y >= 0 && item.x + STUDIO_NODE_WIDTH <= large.width && item.y + STUDIO_NODE_HEIGHT <= large.height)).toBe(true);
    expect(layoutStudioGraph(largeDefinition)).toEqual(large);
  });

  it("lays out empty, disconnected, fanout, fanin, large, and cyclic graphs deterministically", () => {
    const empty = layoutStudioGraph({ ...definition(), nodes: [], edges: [] });
    expect(empty.items).toHaveLength(0);
    const laidOut = layoutStudioGraph(definition());
    expect(laidOut.width).toBeGreaterThanOrEqual(STUDIO_NODE_WIDTH + 48);
    expect(laidOut.height).toBeGreaterThanOrEqual(STUDIO_NODE_HEIGHT + 48);
    const disconnected = layoutStudioGraph({ ...definition(), edges: [] });
    expect(disconnected.items.map(item => item.node.id)).toEqual(["analyze", "verify"]);
    const fanout = layoutStudioGraph({ ...definition(), nodes: [...definition().nodes, { ...definition().nodes[1]!, id: "verify-two" }], edges: [{ from: "analyze", to: "verify" }, { from: "analyze", to: "verify-two" }] });
    expect(new Set(fanout.items.map(item => item.y)).size).toBeGreaterThan(1);
    const cycle = layoutStudioGraph({ ...definition(), edges: [{ from: "analyze", to: "verify" }, { from: "verify", to: "analyze" }] });
    expect(cycle.hasCycle).toBe(true);
    expect(cycle.items.every(item => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
  });
});
