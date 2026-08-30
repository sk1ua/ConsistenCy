import type {
  WorkflowRuntimeDefinition,
  WorkflowRuntimeEdge,
  WorkflowRuntimeNode,
  WorkflowRuntimeNodeType,
} from "@consistency/schema";

export type StudioAction =
  | { type: "add-node"; nodeType: WorkflowRuntimeNodeType; id?: string }
  | { type: "remove-node"; nodeId: string }
  | { type: "connect"; from: string; to: string }
  | { type: "disconnect"; from: string; to: string }
  | { type: "select"; nodeId?: string }
  | { type: "update-params"; nodeId: string; parameters: Record<string, unknown> }
  | { type: "rename"; id: string }
  | { type: "purpose"; purpose: string }
  | { type: "reset" };

export type StudioState = {
  baseline: WorkflowRuntimeDefinition;
  draft: WorkflowRuntimeDefinition;
  selectedNodeId?: string;
  dirty: boolean;
  history: WorkflowRuntimeDefinition[];
};

export type StudioLayoutItem = { node: WorkflowRuntimeNode; x: number; y: number };
export type StudioLayout = { items: StudioLayoutItem[]; width: number; height: number; hasCycle: boolean };
export const STUDIO_NODE_WIDTH = 180;
export const STUDIO_NODE_HEIGHT = 84;
export type StudioPoint = { x: number; y: number };
export type StudioEdgeAnchors = { source: StudioPoint; target: StudioPoint };

/** Return source/target intersections with equal-size node rectangles. */
export function rectangleEdgeAnchors(source: StudioPoint, target: StudioPoint, width = STUDIO_NODE_WIDTH, height = STUDIO_NODE_HEIGHT): StudioEdgeAnchors {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (dx === 0 && dy === 0) return { source: { x: source.x + width / 2, y: source.y }, target: { x: target.x - width / 2, y: target.y } };
  const scale = 1 / Math.max(Math.abs(dx) / (width / 2), Math.abs(dy) / (height / 2));
  const offset = { x: dx * scale, y: dy * scale };
  return { source: { x: source.x + offset.x, y: source.y + offset.y }, target: { x: target.x - offset.x, y: target.y - offset.y } };
}

/** Deterministic, data-only layout. Coordinates are never scaled by the view. */
export function layoutStudioGraph(definition: WorkflowRuntimeDefinition): StudioLayout {
  const nodeWidth = STUDIO_NODE_WIDTH;
  const nodeHeight = STUDIO_NODE_HEIGHT;
  const gapX = 48;
  const gapY = 44;
  const sorted = [...definition.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(sorted.map(node => node.id));
  const outgoing = new Map(sorted.map(node => [node.id, [] as string[]]));
  const indegree = new Map(sorted.map(node => [node.id, 0]));
  let hasSelfEdge = false;
  for (const edge of definition.edges) {
    if (edge.from === edge.to && ids.has(edge.from)) hasSelfEdge = true;
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) {
      outgoing.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
    }
  }
  for (const next of outgoing.values()) next.sort();
  const queue = sorted.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  const rank = new Map<string, number>(queue.map(id => [id, 0]));
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const hasCycle = hasSelfEdge || sorted.some(node => !rank.has(node.id));
  // Cyclic/invalid graphs get a stable single-row fallback, never fake DAG ranks.
  if (hasCycle) {
    const items = sorted.map((node, index) => ({ node, x: 24 + index * (nodeWidth + gapX), y: 24 }));
    return { items, width: Math.max(320, 48 + items.length * (nodeWidth + gapX)), height: 24 + nodeHeight + 24, hasCycle: true };
  }
  const columns = new Map<number, StudioLayoutItem[]>();
  for (const node of sorted) {
    const layer = rank.get(node.id) ?? 0;
    const peers = columns.get(layer) ?? [];
    peers.push({ node, x: 24 + peers.length * (nodeWidth + gapX), y: 24 + layer * (nodeHeight + gapY) });
    columns.set(layer, peers);
  }
  const items = [...columns.values()].flat();
  const maxX = Math.max(0, ...items.map(item => item.x + nodeWidth));
  const maxY = Math.max(0, ...items.map(item => item.y + nodeHeight));
  return { items, width: Math.max(320, maxX + 24), height: Math.max(180, maxY + 24), hasCycle: false };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validParameters(nodeType: WorkflowRuntimeNodeType, parameters: Record<string, unknown>): boolean {
  const allowed = new Map(nodeType.parameterSchema.fields.map(field => [field.name, field]));
  return Object.entries(parameters).every(([name, value]) => {
    const field = allowed.get(name);
    if (!field) return false;
    if (field.type === "string[]" && (!Array.isArray(value) || value.some(item => typeof item !== "string"))) return false;
    if (field.type === "enum" && (typeof value !== "string" || !field.enumValues?.includes(value))) return false;
    if (field.type === "boolean" && typeof value !== "boolean") return false;
    if (field.type === "number" && typeof value !== "number") return false;
    if (field.type === "string" && typeof value !== "string") return false;
    if (field.enumValues && Array.isArray(value) && value.some(item => !field.enumValues?.includes(String(item)))) return false;
    return true;
  });
}

export function serializeStudioDefinition(definition: WorkflowRuntimeDefinition): WorkflowRuntimeDefinition {
  return {
    ...clone(definition),
    nodes: [...definition.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(node => ({ ...node, parameters: Object.fromEntries(Object.entries(node.parameters).sort(([a], [b]) => a.localeCompare(b))) })),
    edges: [...definition.edges].sort((a, b) => `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`)),
  };
}

/** Stable draft identity used to bind validation, persistence, and execution gates. */
export function studioDefinitionFingerprint(definition: WorkflowRuntimeDefinition): string {
  return JSON.stringify(serializeStudioDefinition(definition));
}

export function createStudioState(definition: WorkflowRuntimeDefinition): StudioState {
  const baseline = serializeStudioDefinition(definition);
  return { baseline, draft: clone(baseline), dirty: false, history: [] };
}

function nextId(nodes: WorkflowRuntimeNode[], type: string): string {
  const stem = type.split(".")[0] || "node";
  let index = 1;
  while (nodes.some(node => node.id === `${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

function withDraft(state: StudioState, draft: WorkflowRuntimeDefinition): StudioState {
  const normalized = serializeStudioDefinition(draft);
  return { ...state, draft: normalized, dirty: JSON.stringify(normalized) !== JSON.stringify(state.baseline), history: [...state.history, clone(state.draft)] };
}

export function studioReducer(state: StudioState, action: StudioAction, nodeTypes: WorkflowRuntimeNodeType[]): StudioState {
  const lookup = new Map(nodeTypes.map(nodeType => [nodeType.type, nodeType]));
  switch (action.type) {
    case "reset": return { ...state, draft: clone(state.baseline), dirty: false, selectedNodeId: undefined, history: [] };
    case "select": return { ...state, selectedNodeId: action.nodeId };
    case "purpose": return withDraft(state, { ...state.draft, metadata: { ...(state.draft as WorkflowRuntimeDefinition & { metadata?: Record<string, unknown> }).metadata, purpose: action.purpose } } as WorkflowRuntimeDefinition);
    case "rename": {
      const id = action.id.trim();
      if (!/^[a-z][a-z0-9_-]*$/.test(id) || id === state.draft.id) return state;
      return withDraft(state, { ...state.draft, id });
    }
    case "add-node": {
      if (state.baseline.id.startsWith("verified-") && state.draft.id === state.baseline.id) return state;
      const type = lookup.get(action.nodeType.type);
      if (!type) return state;
      const id = action.id ?? nextId(state.draft.nodes, type.type);
      if (!/^[a-z][a-z0-9_-]*$/.test(id) || state.draft.nodes.some(node => node.id === id)) return state;
      const node: WorkflowRuntimeNode = { id, type: type.type, serviceRef: type.serviceRef, parameters: Object.fromEntries(type.parameterSchema.fields.filter(field => field.default !== undefined).map(field => [field.name, field.default])), failurePolicy: "fail-closed" };
      return { ...withDraft(state, { ...state.draft, nodes: [...state.draft.nodes, node] }), selectedNodeId: id };
    }
    case "remove-node": {
      if (!state.draft.nodes.some(node => node.id === action.nodeId)) return state;
      return { ...withDraft(state, { ...state.draft, nodes: state.draft.nodes.filter(node => node.id !== action.nodeId), edges: state.draft.edges.filter(edge => edge.from !== action.nodeId && edge.to !== action.nodeId) }), selectedNodeId: state.selectedNodeId === action.nodeId ? undefined : state.selectedNodeId };
    }
    case "connect": {
      if (action.from === action.to || !state.draft.nodes.some(node => node.id === action.from) || !state.draft.nodes.some(node => node.id === action.to)) return state;
      if (state.draft.edges.some(edge => edge.from === action.from && edge.to === action.to)) return state;
      return withDraft(state, { ...state.draft, edges: [...state.draft.edges, { from: action.from, to: action.to }] });
    }
    case "disconnect": return withDraft(state, { ...state.draft, edges: state.draft.edges.filter(edge => !(edge.from === action.from && edge.to === action.to)) });
    case "update-params": {
      const node = state.draft.nodes.find(candidate => candidate.id === action.nodeId);
      const type = node && lookup.get(node.type);
      if (!node || !type || !validParameters(type, action.parameters)) return state;
      return withDraft(state, { ...state.draft, nodes: state.draft.nodes.map(candidate => candidate.id === node.id ? { ...candidate, parameters: clone(action.parameters) } : candidate) });
    }
  }
}

export function studioGraphIssues(definition: WorkflowRuntimeDefinition, nodeTypes: WorkflowRuntimeNodeType[]): string[] {
  const ids = new Set<string>();
  const issues: string[] = [];
  const adjacency = new Map<string, string[]>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) issues.push(`duplicate node id: ${node.id}`);
    ids.add(node.id); adjacency.set(node.id, []);
    const type = nodeTypes.find(candidate => candidate.type === node.type);
    if (!type) issues.push(`unknown node type: ${node.type}`);
    else {
      if (type.serviceRef !== node.serviceRef) issues.push(`serviceRef mismatch: ${node.id}`);
      const fields = new Map(type.parameterSchema.fields.map(field => [field.name, field]));
      for (const field of type.parameterSchema.fields) {
        const value = node.parameters[field.name];
        if (field.required && value === undefined) issues.push(`required parameter missing: ${node.id}.${field.name}`);
      }
      for (const [name, value] of Object.entries(node.parameters)) {
        const field = fields.get(name);
        if (!field) { issues.push(`unknown parameter: ${node.id}.${name}`); continue; }
        const valid = field.type === "string" ? typeof value === "string"
          : field.type === "number" ? typeof value === "number" && Number.isFinite(value)
          : field.type === "boolean" ? typeof value === "boolean"
          : field.type === "string[]" ? Array.isArray(value) && value.every(item => typeof item === "string")
          : typeof value === "string" && Boolean(field.enumValues?.includes(value));
        if (!valid) issues.push(`invalid parameter: ${node.id}.${name}`);
      }
    }
  }
  const edges = new Set<string>();
  for (const edge of definition.edges) {
    const key = `${edge.from}\0${edge.to}`;
    if (edges.has(key)) issues.push(`duplicate edge: ${edge.from} → ${edge.to}`);
    edges.add(key);
    if (edge.from === edge.to) issues.push(`self-edge: ${edge.from}`);
    if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`unknown edge endpoint: ${edge.from} → ${edge.to}`);
    else adjacency.get(edge.from)!.push(edge.to);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) { issues.push(`graph cycle: ${id}`); return; } if (visited.has(id)) return; visiting.add(id); for (const next of adjacency.get(id) ?? []) visit(next); visiting.delete(id); visited.add(id); };
  for (const id of ids) visit(id);
  return [...new Set(issues)];
}
