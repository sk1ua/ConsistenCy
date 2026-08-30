// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRuntimeDryLoadResult } from "@consistency/schema";
import { ApiRequestError, api } from "../api/client";
import { zh } from "../i18n";
import { RuntimeStudio, RUNTIME_STUDIO_I18N_KEYS } from "./RuntimeStudio";
import { CopilotPanel, RUNTIME_COPILOT_I18N_KEYS } from "./CopilotPanel";
import { rectangleEdgeAnchors, STUDIO_NODE_HEIGHT, STUDIO_NODE_WIDTH } from "./state";

const nodeType = { type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", role: "analyzer" as const, description: "", capabilityRequirements: [], coeffects: [], parameterSchema: { fields: [{ name: "analyzers", label: "Analyzers", type: "string[]" as const, required: false, enumValues: ["style", "a,b"], default: ["style"] }] } };
const definition = { id: "verified-mini-review", version: 1 as const, nodes: [{ id: "analyze", type: nodeType.type, serviceRef: nodeType.serviceRef, parameters: { analyzers: ["style"] }, failurePolicy: "fail-closed" as const }], edges: [] };
const revision = { revisionId: "wfrev_builtin_verified-mini-review_v1", definitionId: definition.id, revision: 1, status: "validated" as const, definition, validationIssues: [], createdAt: "2026-08-28T00:00:00.000Z" };
const summary = { definitionId: definition.id, origin: "builtin" as const, latestRevision: 1, latestRevisionId: revision.revisionId, status: "validated" as const, createdAt: revision.createdAt, updatedAt: revision.createdAt };
const repo = { id: "repo-local", displayName: "local", source: "local_git" } as never;
let root: Root | undefined;
function render() { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); return host; }
async function settle() { await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); }); }
const canonicalPlan = { definitionId: definition.id, definitionVersion: 1 as const, agentSpecs: [{ nodeId: "analyze", serviceRef: nodeType.serviceRef, order: 0, coeffects: [], capabilityRequirements: [], parameters: { analyzers: ["style"] } }] };
function dryResult(overall: "feasible" | "not-feasible"): WorkflowRuntimeDryLoadResult { return { definitionId: definition.id, revisionId: revision.revisionId, overall, nodes: [], disclaimer: "feasibility-check-only: a successful dry-load does not authorize any syscall; every protected operation is authorized per-call by the Kernel at execution time" }; }
function configure(overrides: Partial<typeof api> = {}) { vi.spyOn(api, "workflowRuntimeOverview").mockResolvedValue({ definition, nodeTypes: [nodeType] }); vi.spyOn(api, "workflowRuntimeDefinitions").mockResolvedValue([summary]); vi.spyOn(api, "repositories").mockResolvedValue([repo]); vi.spyOn(api, "workflowRuntimeRevision").mockResolvedValue(revision); vi.spyOn(api, "validateWorkflowRuntime").mockResolvedValue({ ok: true, errors: [], plan: canonicalPlan }); vi.spyOn(api, "saveWorkflowRuntimeDefinition").mockResolvedValue(revision); vi.spyOn(api, "workflowRuntimeDryLoad").mockResolvedValue(dryResult("feasible")); vi.spyOn(api, "triggerWorkflowRuntime").mockResolvedValue({ runId: "run-1", status: "running", revisionId: revision.revisionId }); Object.assign(api, overrides); }
const originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeEach(() => { configure(); Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true }); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = undefined; vi.restoreAllMocks(); document.body.innerHTML = ""; if (originalActEnvironmentDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironmentDescriptor); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });

function gateRow(host: HTMLElement, key: string) { return host.querySelector<HTMLElement>(`.studio-rail-gate[data-gate="${key}"]`)!; }
function gateAction(host: HTMLElement, key: string) { return gateRow(host, key).querySelector<HTMLButtonElement>("button")!; }
function primaryActions(host: HTMLElement) { return [...host.querySelectorAll<HTMLButtonElement>(".studio-gate-action.primary-button")]; }
function definitionSelect(host: HTMLElement) { return host.querySelector<HTMLSelectElement>("select[aria-label='Definition']")!; }
function repositorySelect(host: HTMLElement) { return host.querySelector<HTMLSelectElement>(".studio-repo select")!; }
async function choose(select: HTMLSelectElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value); select.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function editPurpose(host: HTMLElement, value: string) { const purpose = host.querySelector<HTMLInputElement>("[aria-label='Purpose']")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(purpose, value); purpose.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function renderStudio(): Promise<HTMLElement> { const host = render(); await act(async () => { root!.render(<RuntimeStudio />); }); await settle(); return host; }
async function renderGatedStudio({ withRepository = true, overall = "feasible" }: { withRepository?: boolean; overall?: "feasible" | "not-feasible" } = {}): Promise<HTMLElement> { vi.mocked(api.workflowRuntimeDryLoad).mockResolvedValue(dryResult(overall)); const host = await renderStudio(); await act(async () => { gateAction(host, "validate").click(); }); await settle(); await act(async () => { gateAction(host, "dry").click(); }); await settle(); if (withRepository) await choose(repositorySelect(host), "repo-local"); return host; }

describe("RuntimeStudio executable component contract", () => {
  it("has exact zh-CN parity for every Studio translation key", () => { for (const key of RUNTIME_STUDIO_I18N_KEYS) expect(zh[key]).toBeTruthy(); });
  it("renders overview contract success", async () => { const host = await renderStudio(); expect(host.textContent).toContain("verified-mini-review"); });
  it("renders the desktop gate-evidence rail composition: rail, graph workspace, inspector, and a real definition summary", async () => {
    const host = await renderStudio();
    expect(host.querySelector(".studio-grid .studio-rail")).toBeTruthy();
    expect(host.querySelector(".studio-grid .studio-canvas .studio-graph-frame")).toBeTruthy();
    expect(host.querySelector(".studio-grid .studio-inspector")).toBeTruthy();
    expect(host.querySelector(".studio-actions")).toBeNull();
    expect(host.querySelector(".studio-gate-spine")).toBeNull();
    expect(host.querySelector(".studio-run-reason")).toBeNull();
    expect(host.querySelector(".studio-library")).toBeNull();
    const summaryPanel = host.querySelector(".studio-definition-summary")!;
    expect(summaryPanel.textContent).toContain("Definition summary");
    expect(summaryPanel.textContent).toContain("Nodes");
    expect(summaryPanel.textContent).toContain("Edges");
    expect(summaryPanel.textContent).toContain("linear");
    expect([...summaryPanel.querySelectorAll(".studio-node-list button strong")].map(button => button.textContent)).toEqual(["analyze"]);
    expect(summaryPanel.textContent).toContain("Builtin seeds are fork-only and never overwritten.");
  });
  it("keeps at most one primary gate action and binds it to the current gate", async () => {
    const host = await renderStudio();
    expect(primaryActions(host)).toHaveLength(1);
    expect(gateRow(host, "validate").querySelector(".studio-gate-action.primary-button")).toBeTruthy();
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(true);
    expect((gateAction(host, "persist") as HTMLButtonElement).title).toContain("Persisted revision");
    await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label='New definition']")!.click(); });
    expect(primaryActions(host)).toHaveLength(0);
  });
  it("shows the passed-gate count and the shared next action from the run predicate", async () => {
    const host = await renderStudio();
    expect(host.querySelector(".studio-gate-count")?.textContent).toContain("2/5");
    expect(host.querySelector(".studio-next")?.textContent).toContain("Validate");
    const gated = await renderGatedStudio();
    expect(gated.querySelector(".studio-gate-count")?.textContent).toContain("4/5");
    expect(gated.querySelector(".studio-next")?.textContent).toContain("Run");
  });
  it("renders the graph nodes with the real layout and keeps them readable", async () => {
    const host = await renderStudio();
    const node = host.querySelector<HTMLElement>(".studio-node")!;
    expect(node.style.width).toBe("180px");
    expect(node.style.height).toBe("84px");
    expect(node.title).toContain(nodeType.serviceRef);
    expect(node.textContent).toContain("analyze");
    expect(node.textContent).toContain(nodeType.type);
  });
  it("uses the definition select as the real library and shows forked drafts as drafts", async () => {
    const host = await renderStudio();
    const select = definitionSelect(host);
    expect([...select.options].map(option => option.value)).toEqual(["verified-mini-review"]);
    await act(async () => { host.querySelector<HTMLButtonElement>(".studio-rail-head button.icon-button")!.click(); });
    expect(host.textContent).toContain("new-definition");
    expect(definitionSelect(host).value).toBe("new-definition");
    expect(definitionSelect(host).options[0]!.textContent).toContain("Draft");
  });
  it("keeps the latest definition selection current and aborts superseded in-flight opens", async () => {
    const definitionA = { ...definition, id: "definition-a", nodes: [{ ...definition.nodes[0]!, id: "node-a" }] };
    const definitionB = { ...definition, id: "definition-b", nodes: [{ ...definition.nodes[0]!, id: "node-b" }] };
    const revisionA = { ...revision, definitionId: definitionA.id, revisionId: "revision-a", definition: definitionA } as typeof revision;
    const revisionB = { ...revision, definitionId: definitionB.id, revisionId: "revision-b", definition: definitionB } as typeof revision;
    const summaryA = { ...summary, definitionId: definitionA.id, latestRevisionId: revisionA.revisionId };
    const summaryB = { ...summary, definitionId: definitionB.id, latestRevisionId: revisionB.revisionId };
    let resolveInitial!: (value: typeof revision) => void;
    let resolveB!: (value: typeof revision) => void;
    let signalB!: AbortSignal;
    let signalReopenA!: AbortSignal | undefined;
    vi.mocked(api.workflowRuntimeDefinitions).mockResolvedValue([summaryA, summaryB]);
    vi.mocked(api.workflowRuntimeRevision).mockImplementation((definitionId, _revisionId, signal) => {
      if (definitionId === definitionA.id) {
        if (!resolveInitial) return new Promise(resolve => { resolveInitial = resolve; });
        signalReopenA = signal!;
        return new Promise(() => undefined); // never resolved: must never leak into the UI
      }
      signalB = signal!;
      return new Promise(resolve => { resolveB = resolve; });
    });
    const host = await renderStudio();
    resolveInitial(revisionA);
    await settle();
    expect(host.textContent).toContain("node-a");
    const select = definitionSelect(host);
    expect([...select.options].map(option => option.value)).toEqual(["definition-a", "definition-b"]);
    await choose(select, "definition-b");
    expect(host.textContent).not.toContain("node-b"); // opening replaces the surface while in flight
    resolveB(revisionB);
    await settle();
    expect(host.textContent).toContain("node-b");
    expect(host.textContent).not.toContain("node-a");
    expect(signalB.aborted).toBe(false);
    // Reselecting A starts a fresh open; while it is unresolved the surface
    // stays on the loading state and the stale response can never leak in.
    await choose(definitionSelect(host), "definition-a");
    expect(signalReopenA).toBeDefined();
    expect(signalReopenA!.aborted).toBe(false);
    expect(host.textContent).not.toContain("node-a");
    expect(host.textContent).not.toContain("node-b");
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(signalReopenA!.aborted).toBe(true);
  });
  it("accepts the canonical server validation plan and enables Save on the forked user draft", async () => {
    const host = await renderStudio();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".studio-rail-head button")].find(button => button.textContent === "Fork")!.click(); });
    expect(vi.mocked(api.workflowRuntimeRevision)).toBeDefined();
    await act(async () => { gateAction(host, "validate").click(); });
    await settle();
    expect(vi.mocked(api.validateWorkflowRuntime)).toHaveBeenCalledWith(expect.objectContaining({ id: "verified-mini-review-fork" }), expect.any(AbortSignal));
    expect(host.textContent).toContain("Server validation passed");
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(false);
    expect(gateRow(host, "persist").className).toContain("gate-current");
  });
  it("shows initial failure and retries", async () => { vi.mocked(api.workflowRuntimeOverview).mockRejectedValueOnce(new Error("offline")); const host = await renderStudio(); expect(host.textContent).toContain("offline"); expect(host.querySelector("button")?.textContent).toContain("Retry"); });
  it("fails closed when canonical latestRevisionId is missing without guessing an id", async () => { vi.mocked(api.workflowRuntimeDefinitions).mockResolvedValueOnce([{ ...summary, latestRevisionId: null, latestRevision: null, status: null }]); const host = await renderStudio(); expect(api.workflowRuntimeRevision).not.toHaveBeenCalled(); expect(host.textContent).toContain("Canonical revision metadata is unavailable"); expect(host.textContent).toContain("Retry"); });
  it("keeps the current draft and disables gates while a save response is stale", async () => {
    let resolve!: (value: typeof revision) => void;
    vi.mocked(api.saveWorkflowRuntimeDefinition).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const host = await renderStudio();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".studio-rail-head button")].find(button => button.textContent === "Fork")!.click(); });
    await editPurpose(host, "edited after request");
    await act(async () => { gateAction(host, "validate").click(); });
    await settle();
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { gateAction(host, "persist").click(); });
    await settle();
    await editPurpose(host, "newer draft");
    resolve({ ...revision, definition: { ...revision.definition, metadata: { purpose: "edited after request" } } as typeof revision.definition });
    await settle();
    expect(host.querySelector<HTMLInputElement>("[aria-label='Purpose']")?.value).toBe("newer draft");
    expect(host.textContent).not.toContain("Revision saved");
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector(".studio-run-button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("New clears persisted definition identity", async () => { const host = await renderStudio(); await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label='New definition']")!.click(); }); expect(host.textContent).toContain("new-definition"); });
  it("dirty mutation invalidates validation, save, dry-load, and run gates", async () => {
    const host = await renderStudio();
    await editPurpose(host, "changed");
    expect((gateAction(host, "validate") as HTMLButtonElement).disabled).toBe(false);
    expect((gateAction(host, "dry") as HTMLButtonElement).disabled).toBe(true);
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector(".studio-run-button") as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector("#studio-run-reason")?.textContent).toContain("Run blocked: Validate");
  });
  it("a validated dirty builtin draft offers exactly one clickable Fork action", async () => {
    const host = await renderStudio();
    await editPurpose(host, "local edit");
    await act(async () => { gateAction(host, "validate").click(); });
    await settle();
    const persist = gateAction(host, "persist") as HTMLButtonElement;
    expect(persist.disabled).toBe(false);
    expect(persist.textContent).toContain("Fork");
    expect(persist.title).toContain("Fork before saving a builtin seed");
    expect(gateRow(host, "persist").className).toContain("gate-current");
    expect(primaryActions(host)).toEqual([persist]);
    expect(api.saveWorkflowRuntimeDefinition).not.toHaveBeenCalled();
  });
  it("not-feasible dry load does not unlock run", async () => {
    const host = await renderGatedStudio({ withRepository: true, overall: "not-feasible" });
    expect((host.querySelector(".studio-run-button") as HTMLButtonElement).disabled).toBe(true);
    expect(gateRow(host, "run").className).toContain("gate-blocked");
    expect(host.querySelector("#studio-run-reason")?.textContent).toContain("Dry-load");
    expect(api.triggerWorkflowRuntime).not.toHaveBeenCalled();
  });
  it("builtin fork creates a user definition", async () => { const host = await renderStudio(); await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".studio-rail-head button")].find(button => button.textContent === "Fork")!.click(); }); expect(host.textContent).toContain("verified-mini-review-fork"); expect(host.querySelector(".studio-revision-chip")?.textContent).toContain("Draft"); });
  it("disconnect control is rendered", async () => { const host = await renderStudio(); expect(host.querySelector("[aria-label='Connect nodes']")).toBeTruthy(); });
  it("empty draft disables validate and save and shows the draft gate as blocked", async () => {
    const host = await renderStudio();
    await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label='New definition']")!.click(); });
    expect(host.textContent).toContain("No nodes in draft");
    expect(gateRow(host, "draft").className).toContain("gate-blocked");
    expect((gateAction(host, "validate") as HTMLButtonElement).disabled).toBe(true);
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(true);
  });
  it("selecting a quick-list node swaps the definition summary for the typed inspector", async () => {
    const host = await renderStudio();
    expect(host.querySelector(".studio-inspector summary span")?.textContent).toBe("Definition summary");
    const quick = [...host.querySelectorAll<HTMLButtonElement>(".studio-node-list button")].find(button => button.textContent?.includes("analyze"))!;
    await act(async () => { quick.click(); });
    expect(host.querySelector(".studio-inspector summary span")?.textContent).toBe("analyze");
    expect(host.querySelector(".studio-inspector")?.textContent).toContain(nodeType.serviceRef);
  });
  it("keyboard node selection is supported", async () => {
    const host = await renderStudio();
    const node = host.querySelector<HTMLButtonElement>(".studio-node")!;
    expect(node.className).not.toContain("selected");
    await act(async () => { node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(node.className).toContain("selected");
    expect(host.querySelector(".studio-inspector summary span")?.textContent).toBe("analyze");
  });
  it("SVG exposes explicit dimensions, viewBox, and positioned hooks", async () => {
    const host = await renderStudio();
    const svg = host.querySelector("svg.studio-graph-svg")!;
    expect(svg.getAttribute("width")).toBeTruthy();
    expect(svg.getAttribute("height")).toBeTruthy();
    expect(svg.getAttribute("viewBox")).toMatch(/^0 0 /);
    expect(host.querySelector(".studio-graph")?.getAttribute("style")).toContain("width");
  });
  it("draws horizontal and diagonal edges from rectangle boundaries with a visible marker", async () => {
    const secondNode = { ...definition.nodes[0]!, id: "second" };
    const edgedDefinition = { ...definition, nodes: [...definition.nodes, secondNode], edges: [{ from: "analyze", to: "second" }] };
    const edgedRevision = { ...revision, definition: edgedDefinition, revisionId: "edged-revision" } as typeof revision;
    vi.mocked(api.workflowRuntimeOverview).mockResolvedValue({ definition: edgedDefinition, nodeTypes: [nodeType] });
    vi.mocked(api.workflowRuntimeRevision).mockResolvedValue(edgedRevision);
    vi.mocked(api.workflowRuntimeDefinitions).mockResolvedValue([{ ...summary, latestRevisionId: edgedRevision.revisionId }]);
    const host = await renderStudio();
    const line = host.querySelector<SVGLineElement>(".studio-graph-svg line")!;
    const nodes = [...host.querySelectorAll<HTMLButtonElement>(".studio-node")];
    const sourceNode = nodes.find(node => node.textContent?.includes("analyze"))!;
    const targetNode = nodes.find(node => node.textContent?.includes("second"))!;
    const source = { x: Number.parseFloat(sourceNode.style.left) + STUDIO_NODE_WIDTH / 2, y: Number.parseFloat(sourceNode.style.top) + STUDIO_NODE_HEIGHT / 2 };
    const target = { x: Number.parseFloat(targetNode.style.left) + STUDIO_NODE_WIDTH / 2, y: Number.parseFloat(targetNode.style.top) + STUDIO_NODE_HEIGHT / 2 };
    const expected = rectangleEdgeAnchors(source, target);
    expect(Number(line.getAttribute("x1"))).toBe(expected.source.x);
    expect(Number(line.getAttribute("y1"))).toBe(expected.source.y);
    expect(Number(line.getAttribute("x2"))).toBe(expected.target.x);
    expect(Number(line.getAttribute("y2"))).toBe(expected.target.y);
    expect(`${line.getAttribute("x2")},${line.getAttribute("y2")}`).not.toBe(`${target.x},${target.y}`);
    expect(host.querySelector("marker path")?.getAttribute("d")).toBe("M0,0 L0,6 L7,3 z");
  });

  it("keeps the real layout width on the graph content while a non-scrolling frame owns the edge cues", async () => {
    const host = await renderStudio();
    const frame = host.querySelector<HTMLElement>(".studio-graph-frame")!;
    expect(frame).toBeTruthy();
    expect(frame.className).not.toContain("cue-left");
    expect(frame.className).not.toContain("cue-right");
    expect(frame.closest("details")).toBeNull();
    const viewport = frame.querySelector<HTMLElement>(".studio-graph-viewport")!;
    expect(viewport).toBeTruthy();
    expect(viewport.getAttribute("role")).toBe("group");
    expect(viewport.getAttribute("tabindex")).toBe("0");
    expect(viewport.getAttribute("aria-label")).toBe("Execution graph");
    expect(host.querySelector("[role='application']")).toBeNull();
    const graph = viewport.querySelector<HTMLElement>(".studio-graph")!;
    expect(graph).toBeTruthy();
    expect(graph.style.minWidth).toBeTruthy();
    expect(graph.querySelector("svg.studio-graph-svg")).toBeTruthy();
    expect(graph.querySelectorAll(".studio-node").length).toBeGreaterThan(0);
  });
  it("shows edge cues from real overflow state: right at start, both mid-scroll, left at end, none without overflow", async () => {
    const host = await renderStudio();
    const frame = host.querySelector<HTMLElement>(".studio-graph-frame")!;
    const viewport = frame.querySelector<HTMLElement>(".studio-graph-viewport")!;
    expect(frame.className).not.toContain("cue-left");
    expect(frame.className).not.toContain("cue-right");
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 900 });
    await act(async () => { viewport.dispatchEvent(new Event("scroll")); });
    expect(frame.className).toContain("cue-right");
    expect(frame.className).not.toContain("cue-left");
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, value: 300 });
    await act(async () => { viewport.dispatchEvent(new Event("scroll")); });
    expect(frame.className).toContain("cue-left");
    expect(frame.className).toContain("cue-right");
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, value: 600 });
    await act(async () => { viewport.dispatchEvent(new Event("scroll")); });
    expect(frame.className).toContain("cue-left");
    expect(frame.className).not.toContain("cue-right");
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 300 });
    await act(async () => { viewport.dispatchEvent(new Event("scroll")); });
    expect(frame.className).not.toContain("cue-left");
    expect(frame.className).not.toContain("cue-right");
  });
  it("disconnects the graph ResizeObserver on unmount", async () => {
    const host = await renderStudio();
    expect(host.querySelector(".studio-graph-viewport")).toBeTruthy();
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(disconnect).toHaveBeenCalled();
  });
  it("keeps the 1024/1279 stacked gate-first order with compact pills and one action", async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => { expect(query).toBe("(min-width: 1280px)"); return { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }; } });
    const host = await renderStudio();
    const order = [".studio-rail-head", ".studio-rail-gates", ".studio-next", ".studio-repo", ".studio-canvas", ".studio-inspector"];
    let previous = host.querySelector<HTMLElement>(order[0]!)!;
    for (const selector of order.slice(1)) {
      const element = host.querySelector<HTMLElement>(selector)!;
      expect(element).toBeTruthy();
      expect((previous.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
      previous = element;
    }
    // Graph stays inline on mobile: never wrapped in a collapsed disclosure.
    expect(host.querySelector(".studio-graph-frame")?.closest("details")).toBeNull();
    expect((host.querySelector(".studio-inspector") as HTMLDetailsElement).open).toBe(false);
    expect((host.querySelector("#studio-advanced-controls") as HTMLDetailsElement).open).toBe(false);
    expect((host.querySelector(".studio-advanced-connect") as HTMLDetailsElement).open).toBe(false);
    const ids = [...host.querySelectorAll("[id]")].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Exactly one enabled gate action: the single next action.
    expect(host.querySelectorAll(".studio-rail-gate")).toHaveLength(5);
    expect(host.querySelector(".studio-gate-count")?.textContent).toContain("2/5");
    expect(host.querySelector(".studio-next")?.textContent).toContain("Validate");
    const enabled = [...host.querySelectorAll<HTMLButtonElement>(".studio-gate-action")].filter(button => !button.disabled);
    expect(enabled).toHaveLength(1);
    expect([...host.querySelectorAll<HTMLButtonElement>(".studio-gate-action")].filter(button => button.disabled)).toHaveLength(3);
    expect(enabled[0]!.closest(".studio-rail-gate")?.getAttribute("data-gate")).toBe("validate");
    await act(async () => { (host.querySelector(".studio-inspector summary") as HTMLElement).click(); });
    await settle();
    expect((host.querySelector(".studio-inspector") as HTMLDetailsElement).open).toBe(true);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
  });
  it("keeps desktop Studio presentations open and the graph, palette, and connect controls visible", async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => { expect(query).toBe("(min-width: 1280px)"); return { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }; } });
    const host = await renderStudio();
    expect((host.querySelector(".studio-inspector") as HTMLDetailsElement).open).toBe(true);
    expect((host.querySelector("#studio-advanced-controls") as HTMLDetailsElement).open).toBe(true);
    expect((host.querySelector(".studio-advanced-connect") as HTMLDetailsElement).open).toBe(true);
    expect(host.querySelector(".studio-graph")).toBeTruthy();
    expect(host.querySelector(".studio-palette")).toBeTruthy();
    expect(host.querySelector(".studio-connect")).toBeTruthy();
    for (const element of [...host.querySelectorAll<HTMLElement>("[aria-controls]")]) expect(document.getElementById(element.getAttribute("aria-controls")!)).not.toBeNull();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
  });
  it("uses the 1279/1280 desktop boundary and cleans up the resize listener", async () => {
    const original = window.matchMedia;
    let matches = false; // 1279px: stacked presentation
    const listeners: (() => void)[] = [];
    const remove = vi.fn((_type: string, listener: () => void) => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => { expect(query).toBe("(min-width: 1280px)"); return { get matches() { return matches; }, addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); }, removeEventListener: remove }; } });
    const host = await renderStudio();
    expect((host.querySelector(".studio-inspector") as HTMLDetailsElement).open).toBe(false);
    await act(async () => { matches = true; [...listeners].forEach(listener => listener()); }); // resize to 1280px
    expect((host.querySelector(".studio-inspector") as HTMLDetailsElement).open).toBe(true);
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(remove).toHaveBeenCalledOnce();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
  });
  it("marks exactly the real next action through builtin fork, save, dry-load, repository, and run", async () => {
    const host = await renderStudio();
    expect(host.querySelectorAll(".studio-gate-action.is-current-action")).toHaveLength(1);
    expect(gateAction(host, "validate").classList.contains("is-current-action")).toBe(true);
    await editPurpose(host, "current builtin draft");
    await act(async () => { gateAction(host, "validate").click(); }); await settle();
    expect(gateAction(host, "persist").textContent).toContain("Fork");
    expect(host.querySelectorAll(".studio-gate-action.is-current-action")).toHaveLength(1);
    expect(gateAction(host, "persist").classList.contains("is-current-action")).toBe(true);
    await act(async () => { gateAction(host, "persist").click(); });
    await act(async () => { gateAction(host, "validate").click(); }); await settle();
    expect(gateAction(host, "persist").textContent).toContain("Save revision");
    expect(host.querySelectorAll(".studio-gate-action.is-current-action")).toHaveLength(1);
    await act(async () => { gateAction(host, "persist").click(); }); await settle();
    expect(gateAction(host, "dry").classList.contains("is-current-action")).toBe(true);
    await act(async () => { gateAction(host, "dry").click(); }); await settle();
    expect(host.querySelectorAll(".studio-gate-action.is-current-action")).toHaveLength(0);
    await choose(repositorySelect(host), "repo-local");
    expect(host.querySelector(".studio-run-button")?.classList.contains("is-current-action")).toBe(true);
  });

  it("keeps the single current action marked while that action is busy", async () => {
    const host = await renderStudio();
    await editPurpose(host, "busy validation");
    vi.mocked(api.validateWorkflowRuntime).mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => { gateAction(host, "validate").click(); });
    expect(host.querySelectorAll(".studio-gate-action.is-current-action")).toHaveLength(1);
    expect(gateAction(host, "validate").disabled).toBe(true);
  });

  it("keeps run blocked after a feasible dry-load until a repository is selected, then runs the exact pinned payload", async () => {
    const host = await renderGatedStudio({ withRepository: false });
    const runButton = host.querySelector<HTMLButtonElement>(".studio-run-button")!;
    expect(runButton.disabled).toBe(true);
    expect(host.querySelector("#studio-run-reason")?.textContent).toContain("Select a local repository");
    expect(gateRow(host, "run").className).toContain("gate-blocked");
    expect(api.triggerWorkflowRuntime).not.toHaveBeenCalled();
    await act(async () => { runButton.click(); });
    await settle();
    expect(api.triggerWorkflowRuntime).not.toHaveBeenCalled();
    await choose(repositorySelect(host), "repo-local");
    expect(gateRow(host, "run").className).toContain("gate-current");
    expect(runButton.disabled).toBe(false);
    expect(primaryActions(host)).toHaveLength(1);
    expect(gateRow(host, "run").querySelector(".studio-gate-action.primary-button")).toBeTruthy();
    await act(async () => { runButton.click(); });
    await settle();
    expect(vi.mocked(api.triggerWorkflowRuntime)).toHaveBeenCalledWith("repo-local", { definitionId: "verified-mini-review", revisionId: "wfrev_builtin_verified-mini-review_v1" }, expect.any(AbortSignal));
  });
  it("keeps the run gate current while busy and only disables the button", async () => {
    const host = await renderGatedStudio();
    vi.mocked(api.workflowRuntimeDryLoad).mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => { gateAction(host, "dry").click(); });
    expect((host.querySelector(".studio-run-button") as HTMLButtonElement).disabled).toBe(true);
    expect(gateRow(host, "run").className).toContain("gate-current");
    expect(host.querySelector("#studio-run-reason")?.textContent).toContain("Ready to run the pinned revision");
  });
  it("replaces a failed dry-load error with the success notice and never renders both", async () => {
    const host = await renderStudio();
    await act(async () => { gateAction(host, "validate").click(); });
    await settle();
    vi.mocked(api.workflowRuntimeDryLoad).mockRejectedValueOnce(new Error("dry-load offline"));
    await act(async () => { gateAction(host, "dry").click(); });
    await settle();
    expect(host.textContent).toContain("dry-load offline");
    expect(host.querySelectorAll(".studio-note")).toHaveLength(1);
    await act(async () => { gateAction(host, "dry").click(); });
    await settle();
    expect(host.textContent).not.toContain("dry-load offline");
    expect(host.textContent).toContain("Dry-load feasible");
    expect(host.querySelectorAll(".studio-note")).toHaveLength(1);
  });
  it("keeps the saved current option selectable when definition refresh fails", async () => {
    const saved = { ...revision, definitionId: "saved-definition", definition: { ...definition, id: "saved-definition" } } as typeof revision;
    vi.mocked(api.workflowRuntimeDefinitions).mockResolvedValueOnce([summary]).mockRejectedValueOnce(new Error("refresh offline"));
    vi.mocked(api.saveWorkflowRuntimeDefinition).mockResolvedValueOnce(saved);
    const host = await renderStudio();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".studio-rail-head button")].find(button => button.textContent === "Fork")!.click(); });
    await act(async () => { gateAction(host, "validate").click(); }); await settle();
    await act(async () => { gateAction(host, "persist").click(); }); await settle();
    const select = definitionSelect(host);
    expect(select.value).toBe("saved-definition");
    expect([...select.options].map(option => option.value)).toContain("saved-definition");
    expect(host.textContent).toContain("saved; library refresh failed");
  });
  it("announces first validation and later fingerprint changes with distinct reasons", async () => {
    const host = await renderStudio();
    expect(gateRow(host, "validate").textContent).toContain("Needs validation");
    await act(async () => { gateAction(host, "validate").click(); }); await settle();
    await editPurpose(host, "changed");
    expect(gateRow(host, "validate").textContent).toContain("Draft changed; validate again");
  });
  it("uses and cleans up legacy matchMedia listeners", async () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener, removeListener }) });
    await renderStudio();
    expect(addListener).toHaveBeenCalledOnce();
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0]![0]);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
  });
});

describe("RuntimeStudio Workflow Copilot panel (CKPT6 Phase 3)", () => {
  const copilotProposal = {
    patch: [
      { op: "ADD_NODE" as const, nodeId: "secret-scan", serviceRef: "deterministic-evidence.analyzer" },
      { op: "ADD_EDGE" as const, from: "analyze", to: "secret-scan" }
    ],
    rationale: "adds a secret scan fed by the analyzer"
  };

  it("has exact zh-CN parity for every Copilot translation key", () => {
    for (const key of RUNTIME_COPILOT_I18N_KEYS) expect(zh[key]).toBeTruthy();
    expect(CopilotPanel).toBeDefined();
  });

  async function typeInstruction(host: HTMLElement, value: string) {
    const textarea = host.querySelector<HTMLTextAreaElement>("[aria-label='Copilot instruction']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function propose(host: HTMLElement) {
    await act(async () => { host.querySelector<HTMLButtonElement>(".studio-copilot-submit")!.click(); });
    await settle();
  }

  async function submitInstruction(host: HTMLElement, instruction: string) {
    await typeInstruction(host, instruction);
    await propose(host);
  }

  it("renders the proposal as preview-only: highlighted graph elements, operation list, rationale, unchanged draft", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockResolvedValue({ proposal: copilotProposal });
    const host = await renderStudio();
    await submitInstruction(host, "add a secret scan");
    expect(vi.mocked(api.proposeWorkflowRuntimeCopilotPatch)).toHaveBeenCalledWith({ instruction: "add a secret scan", definition }, expect.any(AbortSignal));
    const panel = host.querySelector(".studio-copilot-proposal")!;
    expect(panel.textContent).toContain("adds a secret scan fed by the analyzer");
    expect(panel.textContent).toContain("ADD_NODE");
    expect(panel.textContent).toContain("deterministic-evidence.analyzer");
    expect(panel.textContent).toContain("analyze → secret-scan");
    const proposedNode = host.querySelector<HTMLButtonElement>(".studio-node.is-proposed")!;
    expect(proposedNode.textContent).toContain("secret-scan");
    expect(proposedNode.disabled).toBe(true);
    expect(host.querySelector(".studio-graph-svg line.is-proposed")).toBeTruthy();
    // Preview only: the draft state (summary node list, gates) is untouched.
    expect([...host.querySelectorAll(".studio-node-list button strong")].map(button => button.textContent)).toEqual(["analyze"]);
    expect(host.querySelector(".studio-gate-count")?.textContent).toContain("2/5");
    expect(host.querySelector(".studio-copilot")?.textContent).toContain("Preview only; the draft is unchanged until you Apply");
  });

  it("disables Apply for an ADD_NODE proposal against an unforked builtin seed with the fork reason", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockResolvedValue({ proposal: copilotProposal });
    const host = await renderStudio();
    await submitInstruction(host, "add a secret scan");
    const apply = host.querySelector<HTMLButtonElement>(".studio-copilot-apply")!;
    expect(apply.disabled).toBe(true);
    expect(apply.title).toContain("Fork before applying a proposal to a builtin seed");
    expect(api.saveWorkflowRuntimeDefinition).not.toHaveBeenCalled();
  });

  it("applies the proposal on a user draft through reducer actions and invalidates the downstream gates", async () => {
    // A user-origin definition: the reducer's add-node guard only fences
    // unforked verified-* builtin seeds, so this draft can take new nodes.
    const userDefinition = { id: "user-flow", version: 1 as const, nodes: definition.nodes, edges: [] as Array<{ from: string; to: string }> };
    const userRevision = { ...revision, definitionId: "user-flow", revisionId: "wfrev_user_user-flow_v1", definition: userDefinition };
    const userSummary = { ...summary, definitionId: "user-flow", origin: "user" as const, latestRevisionId: userRevision.revisionId };
    vi.mocked(api.workflowRuntimeDefinitions).mockResolvedValue([userSummary]);
    vi.mocked(api.workflowRuntimeRevision).mockResolvedValue(userRevision);
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockResolvedValue({ proposal: copilotProposal });
    const host = await renderStudio();
    expect(host.textContent).toContain("user-flow");
    await submitInstruction(host, "add a secret scan");
    const apply = host.querySelector<HTMLButtonElement>(".studio-copilot-apply")!;
    expect(apply.disabled).toBe(false);
    await act(async () => { apply.click(); });
    await settle();
    // Preview cleared; the reducer chain produced the same effect as a manual edit.
    expect(host.querySelector(".studio-copilot-proposal")).toBeNull();
    expect(host.querySelector(".studio-node.is-proposed")).toBeNull();
    expect(host.querySelector(".studio-graph-svg line.is-proposed")).toBeNull();
    expect([...host.querySelectorAll(".studio-node strong")].map(button => button.textContent)).toEqual(["analyze", "secret-scan"]);
    // add-node selects the new node; the typed inspector shows it.
    expect(host.querySelector(".studio-inspector summary span")?.textContent).toBe("secret-scan");
    expect(vi.mocked(api.saveWorkflowRuntimeDefinition)).not.toHaveBeenCalled();
    // Downstream gates invalidated: needs validation, persist/dry/run blocked.
    expect(gateRow(host, "validate").textContent).toContain("Needs validation");
    expect((gateAction(host, "validate") as HTMLButtonElement).disabled).toBe(false);
    expect((gateAction(host, "persist") as HTMLButtonElement).disabled).toBe(true);
    expect((gateAction(host, "dry") as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector(".studio-run-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reject clears the preview without any state residue", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockResolvedValue({ proposal: copilotProposal });
    const host = await renderStudio();
    await submitInstruction(host, "add a secret scan");
    await act(async () => { host.querySelector<HTMLButtonElement>(".studio-copilot-reject")!.click(); });
    await settle();
    expect(host.querySelector(".studio-copilot-proposal")).toBeNull();
    expect(host.querySelector(".studio-node.is-proposed")).toBeNull();
    expect([...host.querySelectorAll(".studio-node-list button strong")]).toHaveLength(1);
    expect(gateRow(host, "validate").textContent).toContain("Needs validation");
    expect(host.querySelector(".studio-copilot-note")).toBeNull();
  });

  it("discards the preview immediately when the draft is edited during preview", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockResolvedValue({ proposal: copilotProposal });
    const host = await renderStudio();
    await submitInstruction(host, "add a secret scan");
    expect(host.querySelector(".studio-copilot-proposal")).toBeTruthy();
    await editPurpose(host, "changed during preview");
    expect(host.querySelector(".studio-copilot-proposal")).toBeNull();
    expect(host.querySelector(".studio-node.is-proposed")).toBeNull();
    expect(host.querySelector(".studio-copilot-status")?.textContent).toContain("Preview discarded; the draft changed");
  });

  it("discards a proposal whose base draft changed while the request was in flight", async () => {
    let resolve!: (value: { proposal: typeof copilotProposal }) => void;
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockReturnValueOnce(new Promise<{ proposal: typeof copilotProposal }>(resolvePromise => { resolve = resolvePromise; }));
    const host = await renderStudio();
    await typeInstruction(host, "add a secret scan");
    await act(async () => { host.querySelector<HTMLButtonElement>(".studio-copilot-submit")!.click(); });
    await editPurpose(host, "edited during flight");
    resolve({ proposal: copilotProposal });
    await settle();
    expect(host.querySelector(".studio-copilot-proposal")).toBeNull();
    expect(host.querySelector(".studio-node.is-proposed")).toBeNull();
    expect(host.querySelector(".studio-copilot-status")?.textContent).toContain("Preview discarded; the draft changed");
  });

  it("maps LLM_NOT_CONFIGURED to honest copy", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockRejectedValueOnce(new ApiRequestError("尚未配置大语言模型", "LLM_NOT_CONFIGURED", 503));
    const host = await renderStudio();
    await submitInstruction(host, "add a secret scan");
    expect(host.querySelector(".studio-copilot-note")?.textContent).toContain("LLM is not configured; configure DeepSeek or OpenAI to generate proposals");
  });

  it("maps WORKFLOW_PATCH_INVALID to the server issues summary", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockRejectedValueOnce(new ApiRequestError("invalid patch", "WORKFLOW_PATCH_INVALID", 400, {
      issues: [{ code: "unknown_service_ref", path: ["patch", 0, "serviceRef"], message: "serviceRef 'fake.service' is not registered in the runtime Node Registry" }]
    }));
    const host = await renderStudio();
    await submitInstruction(host, "add an autoscaler");
    const note = host.querySelector(".studio-copilot-note")?.textContent ?? "";
    expect(note).toContain("The proposal failed server validation");
    expect(note).toContain("fake.service");
  });

  it("maps WORKFLOW_PATCH_GENERATION_FAILED to honest copy", async () => {
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockRejectedValueOnce(new ApiRequestError("generation failed", "WORKFLOW_PATCH_GENERATION_FAILED", 502));
    const host = await renderStudio();
    await submitInstruction(host, "add a secret scan");
    expect(host.querySelector(".studio-copilot-note")?.textContent).toContain("The LLM could not produce a schema-valid proposal; try again");
  });

  it("aborts the in-flight copilot request on unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch").mockImplementation((_input, abortSignal) => {
      signal = abortSignal;
      return new Promise<never>(() => undefined);
    });
    const host = await renderStudio();
    await typeInstruction(host, "add a secret scan");
    await act(async () => { host.querySelector<HTMLButtonElement>(".studio-copilot-submit")!.click(); });
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(signal!.aborted).toBe(true);
  });

  it("disables the proposal submit on an empty draft with an honest reason", async () => {
    const proposalSpy = vi.spyOn(api, "proposeWorkflowRuntimeCopilotPatch");
    const host = await renderStudio();
    await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label='New definition']")!.click(); });
    await typeInstruction(host, "add a secret scan");
    expect(host.querySelector<HTMLButtonElement>(".studio-copilot-submit")!.disabled).toBe(true);
    expect(host.querySelector(".studio-copilot")?.textContent).toContain("Add a node before requesting a proposal");
    expect(proposalSpy).not.toHaveBeenCalled();
  });
});
