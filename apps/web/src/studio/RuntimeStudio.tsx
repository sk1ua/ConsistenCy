import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, GitBranch, LoaderCircle, Play, Plus, Save, ShieldCheck, Trash2, RotateCcw } from "lucide-react";
import type { Repository, WorkflowRuntimeDefinition, WorkflowRuntimeDefinitionRevision, WorkflowRuntimeDefinitionSummary, WorkflowRuntimeNodeType, WorkflowRuntimeDryLoadResult, WorkflowRuntimeCopilotProposal } from "@consistency/schema";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { createStudioState, layoutStudioGraph, rectangleEdgeAnchors, STUDIO_NODE_HEIGHT, STUDIO_NODE_WIDTH, studioDefinitionFingerprint, studioGraphIssues, studioReducer } from "./state";
import { CopilotPanel } from "./CopilotPanel";

export const RUNTIME_STUDIO_I18N_KEYS = [
  "Runtime Studio", "Loading Runtime Studio", "Gate evidence rail", "Definition", "New definition", "No revision", "Fork", "Draft", "Builtin", "User", "Purpose", "Validate", "Dry-load", "Save revision", "Run", "Persist", "Server validation passed", "Server validation failed", "Revision saved", "saved revision, local changes remain", "saved; library refresh failed", "Builtin seeds are fork-only and never overwritten.", "Dry-load feasible", "Dry-load not feasible", "Run started", "Run failed", "No nodes in draft", "Select a node to inspect", "Definition summary", "Nodes", "Edges", "Shape", "linear", "fan-out ×{degree}", "fan-in ×{degree}", "fan-out / fan-in", "Remove node", "Local repository", "Select a local repository", "No repository selected", "Server canonical", "Next action", "gates", "Draft changes", "Persisted revision", "Feasible dry-load", "Blocked", "Passed", "Current", "Pending", "Advanced graph editing", "Selected node", "Execution graph", "Node palette", "Connect nodes", "From node", "To node", "Connect", "Retry", "Studio unavailable", "Could not open definition", "Could not open definition; retry", "Save failed", "Validation failed", "Dry-load failed", "Graph has cycle or invalid edges", "Run blocked", "Reset", "Remove", "Add item", "(legacy)", "{nodes} nodes · {edges} edges · acyclic", "Draft changed; validate again", "Save to pin a revision", "Fork before saving a builtin seed", "Needs validation", "Dry-load the saved revision", "Needs a saved revision", "Ready to run the pinned revision"
] as const;

type OpenTarget = WorkflowRuntimeDefinitionSummary;
type GateKey = "draft" | "validate" | "persist" | "dry" | "run";
type GateStatus = "passed" | "current" | "pending" | "blocked";

const GATE_ORDER: GateKey[] = ["draft", "validate", "persist", "dry", "run"];
const GATE_LABEL_KEYS: Record<GateKey, string> = { draft: "Draft", validate: "Validate", persist: "Persist", dry: "Dry-load", run: "Run" };
const GATE_STATUS_KEYS: Record<GateStatus, string> = { passed: "Passed", current: "Current", pending: "Pending", blocked: "Blocked" };
const GATE_GLYPHS: Record<GateStatus, string> = { passed: "✓", current: "●", pending: "○", blocked: "!" };

function useDesktopStudioPresentation(): boolean {
  // JS and CSS share one desktop branch for Studio presentation at 1280px;
  // narrower widths remain in the stacked presentation.
  const query = "(min-width: 1280px)";
  const [desktop, setDesktop] = useState(() => typeof window === "undefined" || typeof window.matchMedia !== "function" ? false : window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    // Modern browsers expose addEventListener; legacy engines only expose the
    // addListener/removeListener pair. Both paths must unsubscribe.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    const legacy = media as MediaQueryList & { addListener?: (listener: () => void) => void; removeListener?: (listener: () => void) => void };
    legacy.addListener?.(update);
    return () => legacy.removeListener?.(update);
  }, []);
  return desktop;
}

export function RuntimeStudio() {
  const { t } = useI18n();
  const desktopPresentation = useDesktopStudioPresentation();
  const [nodeTypes, setNodeTypes] = useState<WorkflowRuntimeNodeType[]>([]);
  const [definitions, setDefinitions] = useState<WorkflowRuntimeDefinitionSummary[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedSummary, setSelectedSummary] = useState<WorkflowRuntimeDefinitionSummary>();
  const [revision, setRevision] = useState<WorkflowRuntimeDefinitionRevision>();
  const [studioState, setStudioState] = useState<ReturnType<typeof createStudioState> | null>(null);
  const [validatedFingerprint, setValidatedFingerprint] = useState<string>();
  const [savedFingerprint, setSavedFingerprint] = useState<string>();
  const [lastPersistedCheckpoint, setLastPersistedCheckpoint] = useState<WorkflowRuntimeDefinitionRevision>();
  const [dryLoad, setDryLoad] = useState<WorkflowRuntimeDryLoadResult>();
  const [busy, setBusy] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [repositoryId, setRepositoryId] = useState("");
  // Presentation hint only (never an authorization state): whether the current
  // draft lineage has ever passed server validation, so the rail can say
  // "Needs validation" the first time and "Draft changed; validate again"
  // after an edit to a previously validated draft.
  const [hasValidatedDraft, setHasValidatedDraft] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    if (desktopPresentation) {
      setPaletteOpen(true);
      setConnectOpen(true);
      setInspectorOpen(true);
    } else {
      setPaletteOpen(false);
      setConnectOpen(false);
      setInspectorOpen(false);
    }
  }, [desktopPresentation]);
  const [connectFrom, setConnectFrom] = useState("");
  const [connectTo, setConnectTo] = useState("");
  // CKPT6 Phase 3 — Workflow Copilot proposal state. The proposal is preview
  // data bound to the draft fingerprint it was generated against; it never
  // mutates the draft until the human Apply translates it into reducer actions.
  const [copilotProposal, setCopilotProposal] = useState<WorkflowRuntimeCopilotProposal>();
  const [copilotBaseFingerprint, setCopilotBaseFingerprint] = useState<string>();
  const [copilotError, setCopilotError] = useState<unknown>();
  const [copilotStatus, setCopilotStatus] = useState("");
  const generation = useRef(0);
  const operation = useRef<{ generation: number; requestId: number; controller: AbortController } | null>(null);
  const requestId = useRef(0);
  const studioStateRef = useRef<ReturnType<typeof createStudioState> | null>(null);
  studioStateRef.current = studioState;
  const OPEN_TIMEOUT_MS = 15_000;

  const resetGates = () => { setValidatedFingerprint(undefined); setSavedFingerprint(undefined); setDryLoad(undefined); setHasValidatedDraft(false); };
  const clearCopilotPreview = () => { setCopilotProposal(undefined); setCopilotBaseFingerprint(undefined); setCopilotError(undefined); setCopilotStatus(""); };
  const invalidate = () => {
    generation.current += 1;
    operation.current?.controller.abort();
    operation.current = null;
    setBusy(undefined);
    return generation.current;
  };
  const begin = (kind: string, timeout = 0) => {
    operation.current?.controller.abort();
    const controller = new AbortController();
    const identity = { generation: generation.current, requestId: ++requestId.current, controller };
    operation.current = identity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) timer = setTimeout(() => controller.abort(), timeout);
    return { identity, done: () => { if (timer) clearTimeout(timer); }, current: () => operation.current?.generation === identity.generation && operation.current?.requestId === identity.requestId && !controller.signal.aborted };
  };
  const open = async (summary: OpenTarget) => {
    const generationAtStart = invalidate();
    setSelectedSummary(summary); setRevision(undefined); resetGates(); setConnectFrom(""); setConnectTo(""); setNotice(undefined); setError(undefined); setOpenError(undefined); setStudioState(null); clearCopilotPreview();
    const op = begin("open", OPEN_TIMEOUT_MS);
    try {
      if (!summary.latestRevisionId) throw new Error("Canonical revision metadata is unavailable; retry");
      const loaded = await api.workflowRuntimeRevision(summary.definitionId, summary.latestRevisionId, op.identity.controller.signal);
      if (generation.current !== generationAtStart || !op.current()) return;
      setRevision(loaded); setSavedFingerprint(studioDefinitionFingerprint(loaded.definition)); setStudioState(createStudioState(loaded.definition));
    } catch (caught) {
      if (!op.current() || generation.current !== generationAtStart) return;
      setOpenError((caught as Error)?.name === "AbortError" ? t("Could not open definition; retry") : caught instanceof Error ? caught.message : t("Could not open definition"));
    } finally { op.done(); }
  };
  const load = async () => {
    const generationAtStart = invalidate(); setBusy("load"); setLoadError(undefined); setOpenError(undefined);
    const op = begin("load");
    try {
      const [overview, defs, repos] = await Promise.all([api.workflowRuntimeOverview(op.identity.controller.signal), api.workflowRuntimeDefinitions(op.identity.controller.signal), api.repositories(op.identity.controller.signal)]);
      if (!op.current() || generation.current !== generationAtStart) return;
      setNodeTypes(overview.nodeTypes); setDefinitions(defs); setRepositories(repos.filter(repo => repo.source === "local_git"));
      if (defs[0]) await open(defs[0]); else setStudioState(createStudioState({ id: "new-definition", version: 1, nodes: [], edges: [] } as WorkflowRuntimeDefinition));
    } catch (caught) {
      if (op.current() && generation.current === generationAtStart && (caught as Error)?.name !== "AbortError") setLoadError(caught instanceof Error ? caught.message : t("Studio unavailable"));
    } finally { op.done(); if (op.current()) setBusy(undefined); }
  };
  useEffect(() => { void load(); return () => { invalidate(); }; }, []);

  const activeState = studioState;
  const fingerprint = activeState ? studioDefinitionFingerprint(activeState.draft) : "";
  const issues = useMemo(() => activeState ? studioGraphIssues(activeState.draft, nodeTypes) : [], [activeState, nodeTypes]);
  const displayedDefinitions = useMemo(() => {
    if (!selectedSummary || definitions.some(item => item.definitionId === selectedSummary.definitionId)) return definitions;
    return [selectedSummary, ...definitions];
  }, [definitions, selectedSummary]);
  const gatesCurrent = Boolean(activeState && activeState.draft.nodes.length > 0 && issues.length === 0 && validatedFingerprint === fingerprint && savedFingerprint === fingerprint && revision && dryLoad?.revisionId === revision.revisionId && dryLoad.overall === "feasible");
  // Shared run-readiness predicate: every upstream gate current AND a local
  // repository selected. In-flight busy is intentionally excluded so the rail
  // gate states, next action, block reason, and Run button derive from the
  // same predicate; busy only affects clickability.
  const runReady = gatesCurrent && Boolean(repositoryId);
  const gateStates = activeState ? {
    draft: activeState.draft.nodes.length > 0 && issues.length === 0 ? "passed" : "blocked",
    validate: validatedFingerprint === fingerprint ? "passed" : activeState.draft.nodes.length === 0 || issues.length > 0 ? "blocked" : "current",
    persist: savedFingerprint === fingerprint && Boolean(revision) ? "passed" : validatedFingerprint === fingerprint ? "current" : "pending",
    dry: dryLoad?.revisionId === revision?.revisionId && dryLoad?.overall === "feasible" && savedFingerprint === fingerprint ? "passed" : savedFingerprint === fingerprint && validatedFingerprint === fingerprint ? "current" : "pending",
    run: runReady ? "current" : "blocked"
  } as const : null;
  const runBlockReason = !activeState || activeState.draft.nodes.length === 0 ? t("No nodes in draft")
    : issues.length > 0 ? t("Graph has cycle or invalid edges")
      : !validatedFingerprint || validatedFingerprint !== fingerprint ? `${t("Run blocked")}: ${t("Validate")}`
      : !savedFingerprint || savedFingerprint !== fingerprint ? `${t("Run blocked")}: ${selectedSummary?.origin === "builtin" ? t("Fork") : t("Save revision")}`
        : !dryLoad || dryLoad.revisionId !== revision?.revisionId || dryLoad.overall !== "feasible" ? `${t("Run blocked")}: ${t("Dry-load")}`
          : !repositoryId ? t("Select a local repository") : "";
  // Single next action shared by the rail rows, the compact next-action line,
  // and the one primary button. "repo" means the only remaining step is
  // selecting a local repository; "draft" means the graph itself must change.
  const nextGate: GateKey | "repo" = !activeState ? "draft"
    : activeState.draft.nodes.length === 0 || issues.length > 0 ? "draft"
      : gateStates?.validate === "current" ? "validate"
        : gateStates?.persist === "current" ? "persist"
          : gateStates?.dry === "current" ? "dry"
            : !repositoryId ? "repo" : "run";
  const nextLabel = !activeState ? "" : nextGate === "repo" ? t("Select a local repository") : nextGate === "draft" ? t("Draft changes") : nextGate === "persist" && selectedSummary?.origin === "builtin" ? t("Fork") : t(GATE_LABEL_KEYS[nextGate]);
  const passedCount = gateStates ? GATE_ORDER.filter(key => gateStates[key] === "passed").length : 0;
  const firstIssue = issues[0];
  const gateEvidence: Record<GateKey, string> = activeState && gateStates ? {
    draft: activeState.draft.nodes.length === 0 ? t("No nodes in draft") : issues.length > 0 ? firstIssue! : t("{nodes} nodes · {edges} edges · acyclic", { nodes: activeState.draft.nodes.length, edges: activeState.draft.edges.length }),
    validate: gateStates.validate === "passed" ? t("Server canonical") : gateStates.validate === "blocked" ? (firstIssue ?? t("No nodes in draft")) : hasValidatedDraft ? t("Draft changed; validate again") : t("Needs validation"),
    persist: gateStates.persist === "passed" ? `${t("Persisted revision")} · r${revision?.revision ?? ""}` : gateStates.persist === "current" ? (selectedSummary?.origin === "builtin" ? t("Fork before saving a builtin seed") : t("Save to pin a revision")) : t("Needs validation"),
    dry: gateStates.dry === "passed" ? t("Feasible dry-load") : gateStates.dry === "current" ? t("Dry-load the saved revision") : t("Needs a saved revision"),
    run: gateStates.run === "current" ? t("Ready to run the pinned revision") : runBlockReason
  } : { draft: "", validate: "", persist: "", dry: "", run: "" };
  const shape = useMemo(() => {
    if (!activeState || activeState.draft.nodes.length === 0) return "—";
    const outgoing = new Map<string, number>();
    const incoming = new Map<string, number>();
    for (const edge of activeState.draft.edges) {
      outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
    const maxOut = Math.max(0, ...outgoing.values());
    const maxIn = Math.max(0, ...incoming.values());
    if (maxOut > 1 && maxIn > 1) return t("fan-out / fan-in");
    if (maxOut > 1) return t("fan-out ×{degree}", { degree: maxOut });
    if (maxIn > 1) return t("fan-in ×{degree}", { degree: maxIn });
    return t("linear");
  }, [activeState, t]);
  const originLabel = selectedSummary ? (selectedSummary.origin === "builtin" ? t("Builtin") : t("User")) : t("Draft");
  const revisionLabel = revision ? `r${revision.revision}` : t("No revision");
  const busyLabel = busy === "validate" ? t("Validate") : busy === "save" ? t("Save revision") : busy === "dry" ? t("Dry-load") : busy === "run" ? t("Run") : busy === "copilot" ? t("Copilot proposal") : busy === "open" ? t("Loading Runtime Studio") : undefined;
  const definitionSelectValue = selectedSummary ? selectedSummary.definitionId : activeState?.draft.id ?? "";
  // CKPT6 Phase 3 — diff preview: the rendered graph is draft + proposed patch
  // (preview data only). The draft state itself stays untouched until Apply.
  const copilotPreview = useMemo(() => {
    if (!activeState || !copilotProposal) return null;
    const registryByRef = new Map(nodeTypes.map(candidate => [candidate.serviceRef, candidate]));
    const nodes = [...activeState.draft.nodes];
    for (const operation of copilotProposal.patch) {
      if (operation.op !== "ADD_NODE") continue;
      const nodeType = registryByRef.get(operation.serviceRef);
      // An unknown serviceRef cannot be previewed honestly — render no preview.
      if (!nodeType) return null;
      nodes.push({ id: operation.nodeId, type: nodeType.type, serviceRef: nodeType.serviceRef, parameters: operation.parameters ?? {}, failurePolicy: "fail-closed" });
    }
    return {
      proposedNodeIds: new Set(copilotProposal.patch.filter(operation => operation.op === "ADD_NODE").map(operation => operation.nodeId)),
      proposedEdgeKeys: new Set(copilotProposal.patch.filter(operation => operation.op === "ADD_EDGE").map(operation => `${operation.from}-${operation.to}`)),
      definition: {
        ...activeState.draft,
        nodes,
        edges: [...activeState.draft.edges, ...copilotProposal.patch.filter(operation => operation.op === "ADD_EDGE").map(operation => ({ from: operation.from, to: operation.to }))]
      } as WorkflowRuntimeDefinition
    };
  }, [activeState, copilotProposal, nodeTypes]);
  const layout = useMemo(() => activeState ? layoutStudioGraph(copilotPreview ? copilotPreview.definition : activeState.draft) : null, [copilotPreview, activeState]);
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const [graphScroll, setGraphScroll] = useState({ overflow: false, left: false, right: false });
  const updateGraphScroll = useCallback(() => {
    const viewport = graphViewportRef.current;
    if (!viewport) return;
    const maxScroll = viewport.scrollWidth - viewport.clientWidth;
    const overflow = maxScroll > 1;
    setGraphScroll({ overflow, left: overflow && viewport.scrollLeft > 1, right: overflow && viewport.scrollLeft < maxScroll - 1 });
  }, []);
  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (!viewport) return;
    updateGraphScroll();
    // Re-measure when the viewport itself resizes (ResizeObserver with a
    // window-resize fallback); layout-driven content changes re-run this
    // effect through the layout dimensions in the dependency list.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => updateGraphScroll());
      observer.observe(viewport);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateGraphScroll);
    return () => window.removeEventListener("resize", updateGraphScroll);
  }, [layout?.width, layout?.height, updateGraphScroll]);
  // A draft edit during preview immediately invalidates the copilot proposal:
  // the patch was validated against a different definition, so the preview is
  // discarded via the studioDefinitionFingerprint comparison. Apply itself
  // clears the preview first, so its own fingerprint change never trips this.
  useEffect(() => {
    if (!copilotProposal || copilotBaseFingerprint === undefined) return;
    if (fingerprint === copilotBaseFingerprint) return;
    setCopilotProposal(undefined);
    setCopilotBaseFingerprint(undefined);
    setCopilotStatus(t("Preview discarded; the draft changed"));
  }, [fingerprint, copilotProposal, copilotBaseFingerprint, t]);
  if (!activeState || !layout) return <section className="runtime-studio" aria-label={t("Runtime Studio")}><div className="studio-loading" role="alert">{loadError || openError ? <><p>{loadError ?? openError}</p><button className="secondary-button btn-small" onClick={() => loadError ? void load() : selectedSummary && void open(selectedSummary)}>{t("Retry")}</button></> : <><LoaderCircle className="spin" size={18} />{t("Loading Runtime Studio")}</>}</div></section>;
  const selected = activeState.draft.nodes.find(node => node.id === activeState.selectedNodeId);
  const selectedType = selected ? nodeTypes.find(type => type.type === selected.type) : undefined;
  const mutate = (next: ReturnType<typeof studioReducer>) => { setStudioState(next); setValidatedFingerprint(undefined); setSavedFingerprint(undefined); setDryLoad(undefined); };
  // CKPT6 Phase 3 — copilot proposal submit. Reuses the shared operation
  // machinery (generation + AbortController) so a superseding open/load/inval-
  // idation aborts the in-flight LLM request, and unmount aborts it via
  // invalidate() in the load effect cleanup.
  const submitCopilot = async (instruction: string) => {
    if (!activeState || busy) return;
    const requestGeneration = generation.current;
    const requestFingerprint = fingerprint;
    const requestDefinition = activeState.draft;
    const op = begin("copilot");
    setBusy("copilot");
    setCopilotError(undefined);
    setCopilotStatus("");
    try {
      const result = await api.proposeWorkflowRuntimeCopilotPatch({ instruction, definition: requestDefinition }, op.identity.controller.signal);
      if (!op.current() || generation.current !== requestGeneration) return;
      // The draft may have changed while the request was in flight; a proposal
      // validated against a different definition is discarded, never applied.
      if (studioDefinitionFingerprint(studioStateRef.current?.draft as WorkflowRuntimeDefinition) !== requestFingerprint) {
        setCopilotStatus(t("Preview discarded; the draft changed"));
        return;
      }
      setCopilotProposal(result.proposal);
      setCopilotBaseFingerprint(requestFingerprint);
    } catch (caught) {
      if (op.current() && generation.current === requestGeneration && (caught as Error)?.name !== "AbortError") setCopilotError(caught);
    } finally {
      op.done();
      if (op.current()) setBusy(undefined);
    }
  };
  // Apply translates the proposal into existing reducer actions one by one
  // (add-node / update-params / connect) — never a direct draft-JSON write.
  // The resulting draft then flows through the canonical validate →
  // save-revision gate chain like any manual edit.
  const applyCopilotProposal = () => {
    const current = studioStateRef.current;
    if (!current || !copilotProposal || busy) return;
    let next = current;
    for (const operation of copilotProposal.patch) {
      if (operation.op === "ADD_NODE") {
        const nodeType = nodeTypes.find(candidate => candidate.serviceRef === operation.serviceRef);
        // The server whitelist-validated the serviceRef; a missing local
        // registry entry means a stale registry — fail closed, apply nothing.
        if (!nodeType) return;
        next = studioReducer(next, { type: "add-node", nodeType, id: operation.nodeId }, nodeTypes);
        if (operation.parameters && Object.keys(operation.parameters).length > 0) {
          next = studioReducer(next, { type: "update-params", nodeId: operation.nodeId, parameters: operation.parameters }, nodeTypes);
        }
        continue;
      }
      next = studioReducer(next, { type: "connect", from: operation.from, to: operation.to }, nodeTypes);
    }
    if (next === current) return;
    mutate(next);
    clearCopilotPreview();
  };
  const rejectCopilotProposal = () => { clearCopilotPreview(); };
  // Mirror of the reducer add-node guard: an unforked builtin seed cannot take
  // new nodes, so an ADD_NODE proposal must be forked first. Edge-only patches
  // follow the same rules as the manual connect control.
  const copilotNeedsFork = Boolean(copilotProposal?.patch.some(operation => operation.op === "ADD_NODE") && activeState.baseline.id.startsWith("verified-") && activeState.draft.id === activeState.baseline.id);
  const newDefinition = () => { invalidate(); setSelectedSummary(undefined); setRevision(undefined); resetGates(); setConnectFrom(""); setConnectTo(""); setNotice(undefined); setError(undefined); setOpenError(undefined); setStudioState(createStudioState({ id: "new-definition", version: 1, nodes: [], edges: [] } as WorkflowRuntimeDefinition)); clearCopilotPreview(); };
  const fork = () => { invalidate(); const id = `${activeState.draft.id}-fork`; const unique = definitions.some(item => item.definitionId === id) ? `${id}-${Date.now().toString(36)}` : id; setSelectedSummary(undefined); setRevision(undefined); resetGates(); setConnectFrom(""); setConnectTo(""); setNotice(undefined); setError(undefined); setOpenError(undefined); setStudioState(createStudioState({ ...activeState.draft, id: unique })); clearCopilotPreview(); };
  const validate = async () => { if (activeState.draft.nodes.length === 0) return; const requestGeneration = generation.current; const requestFingerprint = fingerprint; const op = begin("validate"); setBusy("validate"); setError(undefined); try { const result = await api.validateWorkflowRuntime(activeState.draft, op.identity.controller.signal); if (!op.current() || generation.current !== requestGeneration || studioDefinitionFingerprint(studioStateRef.current?.draft as WorkflowRuntimeDefinition) !== requestFingerprint) return; if (result.ok) { setValidatedFingerprint(requestFingerprint); setHasValidatedDraft(true); } else { setValidatedFingerprint(undefined); } setNotice(result.ok ? t("Server validation passed") : t("Server validation failed")); } catch (caught) { if (op.current() && generation.current === requestGeneration) { setValidatedFingerprint(undefined); if ((caught as Error)?.name !== "AbortError") setError(caught instanceof Error ? caught.message : t("Validation failed")); } } finally { op.done(); if (op.current()) setBusy(undefined); } };
  const save = async () => {
    if (validatedFingerprint !== fingerprint || activeState.draft.nodes.length === 0) return;
    const requestGeneration = generation.current; const requestFingerprint = fingerprint; const requestDefinition = activeState.draft; const op = begin("save");
    setBusy("save"); setError(undefined);
    try {
      const saved = await api.saveWorkflowRuntimeDefinition({ definitionId: selectedSummary?.origin === "user" && selectedSummary.definitionId === requestDefinition.id ? selectedSummary.definitionId : undefined, definition: requestDefinition }, op.identity.controller.signal);
      if (!op.current() || generation.current !== requestGeneration) return;
      const current = studioStateRef.current;
      const isCurrentDraft = current !== null && studioDefinitionFingerprint(current.draft) === requestFingerprint;
      setLastPersistedCheckpoint(saved);
      if (isCurrentDraft) {
        setRevision(saved);
        setSelectedSummary({ definitionId: saved.definitionId, origin: "user", latestRevision: saved.revision, latestRevisionId: saved.revisionId, status: saved.status, createdAt: saved.createdAt, updatedAt: saved.createdAt });
        setStudioState(createStudioState(saved.definition)); setSavedFingerprint(studioDefinitionFingerprint(saved.definition)); setValidatedFingerprint(studioDefinitionFingerprint(saved.definition)); setDryLoad(undefined); setNotice(t("Revision saved"));
      } else {
        // Persisted checkpoint is informational only; current draft and its
        // execution gates remain untouched until it is independently saved.
        setNotice(t("saved revision, local changes remain"));
      }
      try {
        const defs = await api.workflowRuntimeDefinitions(op.identity.controller.signal);
        if (op.current() && generation.current === requestGeneration) setDefinitions(defs);
      } catch {
        if (op.current() && generation.current === requestGeneration) setNotice(t("saved; library refresh failed"));
      }
    } catch (caught) { if (op.current() && generation.current === requestGeneration && (caught as Error)?.name !== "AbortError") setError(caught instanceof Error ? caught.message : t("Save failed")); } finally { op.done(); if (op.current()) setBusy(undefined); }
  };
  const doDryLoad = async () => { if (validatedFingerprint !== fingerprint || !revision || savedFingerprint !== fingerprint) return; const requestGeneration = generation.current; const requestFingerprint = fingerprint; setError(undefined); const op = begin("dry"); setBusy("dry"); try { const result = await api.workflowRuntimeDryLoad(revision.definitionId, revision.revisionId, op.identity.controller.signal); if (!op.current() || generation.current !== requestGeneration || studioDefinitionFingerprint(studioStateRef.current?.draft as WorkflowRuntimeDefinition) !== requestFingerprint) return; setDryLoad(result); setNotice(result.overall === "feasible" ? t("Dry-load feasible") : `${t("Dry-load not feasible")}: ${result.nodes.flatMap(node => node.issues.map(issue => issue.message)).slice(0, 3).join("; ")}`); } catch (caught) { if (op.current() && generation.current === requestGeneration && (caught as Error)?.name !== "AbortError") { setDryLoad(undefined); setError(caught instanceof Error ? caught.message : t("Dry-load failed")); } } finally { op.done(); if (op.current()) setBusy(undefined); } };
  const run = async () => { if (!runReady || !revision) return; const requestGeneration = generation.current; setError(undefined); const op = begin("run"); setBusy("run"); try { const created = await api.triggerWorkflowRuntime(repositoryId, { definitionId: revision.definitionId, revisionId: revision.revisionId }, op.identity.controller.signal); if (!op.current() || generation.current !== requestGeneration) return; setNotice(`${t("Run started")} · ${created.runId}`); } catch (caught) { if (op.current() && generation.current === requestGeneration && (caught as Error)?.name !== "AbortError") setError(caught instanceof Error ? caught.message : t("Run failed")); } finally { op.done(); if (op.current()) setBusy(undefined); } };
  const gateActionClass = (key: GateKey) => `studio-gate-action btn-small ${nextGate === key ? "primary-button" : "secondary-button"} ${nextGate === key ? "is-current-action" : ""}`;
  const gateActionTitle = (key: GateKey) => gateEvidence[key];
  return <section className="runtime-studio" aria-label={t("Runtime Studio")}>
    <div className="studio-grid">
      <aside className="studio-rail" aria-label={t("Gate evidence rail")}>
        <div className="studio-rail-head">
          <span className="panel-kicker studio-rail-title"><GitBranch size={14} /> {t("Runtime Studio")}</span>
          <label className="studio-defselect">
            <span>{t("Definition")}</span>
            <select aria-label={t("Definition")} value={definitionSelectValue} onChange={event => { const target = definitions.find(summary => summary.definitionId === event.target.value); if (target) void open(target); }}>
              {!selectedSummary && <option value={definitionSelectValue}>{definitionSelectValue} · {t("Draft")}</option>}
              {displayedDefinitions.map(summary => <option key={summary.definitionId} value={summary.definitionId}>{summary.definitionId} · {summary.origin === "builtin" ? t("Builtin") : t("User")}{summary.latestRevision !== null ? ` · r${summary.latestRevision}` : ""}</option>)}
            </select>
          </label>
          <div className="studio-rail-meta">
            <span className="studio-revision-chip">{originLabel} · {revisionLabel}</span>
            {selectedSummary?.origin === "builtin" && <button type="button" className="secondary-button btn-small studio-header-fork" onClick={fork}>{t("Fork")}</button>}
            <button type="button" className="icon-button" aria-label={t("New definition")} onClick={newDefinition}><Plus size={14} /></button>
          </div>
        </div>
        <ol className="studio-rail-gates">
          {GATE_ORDER.map(key => {
            const status = gateStates?.[key] ?? "pending";
            return <li key={key} className={`studio-rail-gate gate-${status}`} data-gate={key} data-status={status}>
              <i aria-hidden="true">{GATE_GLYPHS[status]}</i>
              <div className="studio-rail-gate-body">
                <strong>{t(GATE_LABEL_KEYS[key])}<span className="studio-visually-hidden"> — {t(GATE_STATUS_KEYS[status])}</span></strong>
                <small id={key === "run" ? "studio-run-reason" : undefined}>{gateEvidence[key]}</small>
                {key === "validate" && <button type="button" className={gateActionClass(key)} disabled={busy !== undefined || activeState.draft.nodes.length === 0 || issues.length > 0} title={gateActionTitle(key)} onClick={() => void validate()}><CheckCircle2 size={13} />{t("Validate")}</button>}
                {key === "persist" && selectedSummary?.origin === "builtin" && gateStates?.persist === "current" && <button type="button" className={gateActionClass(key)} disabled={busy !== undefined} title={gateActionTitle(key)} onClick={fork}><GitBranch size={13} />{t("Fork")}</button>}
                {key === "persist" && !(selectedSummary?.origin === "builtin" && gateStates?.persist === "current") && <button type="button" className={gateActionClass(key)} disabled={busy !== undefined || validatedFingerprint !== fingerprint || selectedSummary?.origin === "builtin" || activeState.draft.nodes.length === 0} title={gateActionTitle(key)} onClick={() => void save()}><Save size={13} />{t("Save revision")}</button>}
                {key === "dry" && <button type="button" className={gateActionClass(key)} disabled={validatedFingerprint !== fingerprint || savedFingerprint !== fingerprint || !revision || busy !== undefined} title={gateActionTitle(key)} onClick={() => void doDryLoad()}><ShieldCheck size={13} />{t("Dry-load")}</button>}
                {key === "run" && <button type="button" className={`${gateActionClass(key)} studio-run-button`} disabled={!runReady || busy !== undefined} title={gateActionTitle(key)} aria-describedby="studio-run-reason" onClick={() => void run()}><Play size={13} />{t("Run")}</button>}
              </div>
            </li>;
          })}
        </ol>
        <div className="studio-next">
          <span className="studio-gate-count">{passedCount}/{GATE_ORDER.length} {t("gates")}</span>
          <span className="studio-next-label">{t("Next action")}: <b>{nextLabel}</b></span>
        </div>
        {(busyLabel || notice || error) && <div className="studio-rail-status">
          {busyLabel && <span className="studio-busy"><LoaderCircle className="spin" size={13} />{busyLabel}</span>}
          {(error || notice) && <div className={`studio-note${error ? "" : " notice-success"}`} role={error ? "alert" : "status"}>{error ?? notice}</div>}
        </div>}
        <label className="studio-repo">
          <span>{t("Local repository")}</span>
          <select aria-label={t("Local repository")} value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>
            <option value="">{t("Select a local repository")}</option>
            {repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.displayName}</option>)}
          </select>
          <small className={`studio-repo-state ${repositoryId ? "ok" : "unset"}`}>{repositoryId ? repositories.find(repo => repo.id === repositoryId)?.displayName ?? repositoryId : t("No repository selected")}</small>
        </label>
      </aside>
      <section className="studio-canvas" aria-label={t("Execution graph")}>
        <div className="studio-canvas-toolbar" role="toolbar" aria-label={t("Execution graph")}><strong>{activeState.draft.id}</strong><input aria-label={t("Purpose")} placeholder={t("Purpose")} value={activeState.draft.metadata?.purpose ?? ""} onChange={event => mutate(studioReducer(activeState, { type: "purpose", purpose: event.target.value }, nodeTypes))} /></div>
        {activeState.draft.nodes.length === 0 && <div className="studio-empty">{t("No nodes in draft")}</div>}
        {layout.hasCycle && <div className="studio-issue" role="alert">{t("Graph has cycle or invalid edges")}</div>}
        <div className={`studio-graph-frame${graphScroll.overflow ? " has-overflow" : ""}${graphScroll.left ? " cue-left" : ""}${graphScroll.right ? " cue-right" : ""}`}><div className="studio-graph-viewport" ref={graphViewportRef} role="group" aria-label={t("Execution graph")} tabIndex={0} onScroll={updateGraphScroll}><div className="studio-graph" style={{ width: layout.width, minWidth: layout.width, height: layout.height, minHeight: layout.height }}><svg className="studio-graph-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden="true"><defs><marker id="studio-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" /></marker></defs>{(copilotPreview ? copilotPreview.definition.edges : activeState.draft.edges).map(edge => { const a = layout.items.find(item => item.node.id === edge.from); const b = layout.items.find(item => item.node.id === edge.to); return a && b && edge.from !== edge.to ? (() => { const anchors = rectangleEdgeAnchors({ x: a.x + STUDIO_NODE_WIDTH / 2, y: a.y + STUDIO_NODE_HEIGHT / 2 }, { x: b.x + STUDIO_NODE_WIDTH / 2, y: b.y + STUDIO_NODE_HEIGHT / 2 }); return <line key={`${edge.from}-${edge.to}`} className={copilotPreview?.proposedEdgeKeys.has(`${edge.from}-${edge.to}`) ? "is-proposed" : undefined} x1={anchors.source.x} y1={anchors.source.y} x2={anchors.target.x} y2={anchors.target.y} markerEnd="url(#studio-arrow)" />; })() : null; })}</svg>{layout.items.map(({ node, x, y }) => <button key={node.id} type="button" className={`studio-node${copilotPreview?.proposedNodeIds.has(node.id) ? " is-proposed" : ""}${selected?.id === node.id ? " selected" : ""}`} aria-pressed={selected?.id === node.id} disabled={copilotPreview?.proposedNodeIds.has(node.id) || undefined} aria-label={`${node.id}: ${node.type}; ${node.serviceRef}`} title={`${node.id}: ${node.type}; ${node.serviceRef}`} style={{ left: x, top: y, width: STUDIO_NODE_WIDTH, height: STUDIO_NODE_HEIGHT }} onClick={() => setStudioState({ ...activeState, selectedNodeId: node.id })} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") setStudioState({ ...activeState, selectedNodeId: node.id }); }}><strong>{node.id}</strong><span>{node.type}</span><small>{node.serviceRef}</small></button>)}</div></div><span className="studio-graph-cue studio-graph-cue-left" aria-hidden="true" /><span className="studio-graph-cue studio-graph-cue-right" aria-hidden="true" /></div>
        <details id="studio-advanced-controls" className="studio-advanced" open={desktopPresentation || paletteOpen} onToggle={event => setPaletteOpen(event.currentTarget.open)}><summary>{t("Advanced graph editing")}</summary><div className="studio-palette" role="group" aria-label={t("Node palette")}>{nodeTypes.map(nodeType => <button key={nodeType.type} className="secondary-button btn-small" onClick={() => mutate(studioReducer(activeState, { type: "add-node", nodeType }, nodeTypes))}><Plus size={13} />{nodeType.type}</button>)}</div></details>
        <details className="studio-advanced studio-advanced-connect" open={desktopPresentation || connectOpen} onToggle={event => setConnectOpen(event.currentTarget.open)}><summary>{t("Connect nodes")}</summary><div className="studio-connect" role="group" aria-label={t("Connect nodes")}><select aria-label={t("From node")} value={connectFrom} onChange={event => setConnectFrom(event.target.value)}><option value="">{t("From node")}</option>{activeState.draft.nodes.map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select><span aria-hidden="true">→</span><select aria-label={t("To node")} value={connectTo} onChange={event => setConnectTo(event.target.value)}><option value="">{t("To node")}</option>{activeState.draft.nodes.map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select><button className="secondary-button btn-small" disabled={!connectFrom || !connectTo} onClick={() => { mutate(studioReducer(activeState, { type: "connect", from: connectFrom, to: connectTo }, nodeTypes)); setConnectFrom(""); setConnectTo(""); }}>{t("Connect")}</button></div><div className="studio-edges">{activeState.draft.edges.map(edge => <button key={`${edge.from}-${edge.to}`} onClick={() => mutate(studioReducer(activeState, { type: "disconnect", from: edge.from, to: edge.to }, nodeTypes))}>{edge.from} → {edge.to} <Trash2 size={12} /></button>)}</div></details>
      </section>
      <div className="studio-right">
      <details id="studio-node-inspector" className="studio-inspector" open={desktopPresentation || inspectorOpen} onToggle={event => setInspectorOpen(event.currentTarget.open)}>
        <summary>{t("Selected node")}<span>{selected?.id ?? t("Definition summary")}</span></summary>
        {!selected || !selectedType ? <div className="studio-definition-summary">
          <h3>{t("Definition summary")}</h3>
          <p className="studio-summary-purpose">{(activeState.draft as WorkflowRuntimeDefinition & { metadata?: { purpose?: string } }).metadata?.purpose || "—"}</p>
          <dl className="studio-summary-facts">
            <div><dt>{t("Nodes")}</dt><dd>{activeState.draft.nodes.length}</dd></div>
            <div><dt>{t("Edges")}</dt><dd>{activeState.draft.edges.length}</dd></div>
            <div><dt>{t("Shape")}</dt><dd>{shape}</dd></div>
          </dl>
          {selectedSummary?.origin === "builtin" && <p className="studio-summary-fork">{t("Builtin seeds are fork-only and never overwritten.")}</p>}
          <p className="studio-summary-hint">{t("Select a node to inspect")}</p>
          <ul className="studio-node-list">
            {activeState.draft.nodes.map(node => <li key={node.id}><button type="button" onClick={() => setStudioState({ ...activeState, selectedNodeId: node.id })}><strong>{node.id}</strong><span>{node.type}</span></button></li>)}
          </ul>
        </div> : <><h3>{selected.id}</h3><p><strong>{selected.type}</strong><br />{selectedType.serviceRef}</p>{selectedType.parameterSchema.fields.map(field => { const value = selected.parameters[field.name]; if (field.type === "string[]") { const values = Array.isArray(value) ? value as string[] : []; return <fieldset key={field.name}><legend>{field.label}</legend>{field.enumValues ? <>{field.enumValues.map(option => <label key={option} className="studio-check"><input type="checkbox" checked={values.includes(option)} onChange={event => mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: event.target.checked ? [...values, option] : values.filter(item => item !== option) } }, nodeTypes))} />{option}</label>)}{values.filter(item => !field.enumValues!.includes(item)).map(item => <label key={`legacy-${item}`} className="studio-check legacy-value"><input type="checkbox" checked onChange={() => mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: values.filter(candidate => candidate !== item) } }, nodeTypes))} />{item} {t("(legacy)")}</label>)}</> : <>{values.map((item, index) => <div className="studio-array-row" key={`${field.name}-${index}`}><input aria-label={`${field.label} ${index + 1}`} value={item} onChange={event => { const next = [...values]; next[index] = event.target.value; mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: next } }, nodeTypes)); }} /><button type="button" onClick={() => mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: values.filter((_, i) => i !== index) } }, nodeTypes))}>{t("Remove")}</button></div>)}<button type="button" onClick={() => mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: [...values, ""] } }, nodeTypes))}>{t("Add item")}</button></>}</fieldset>; } return <label key={field.name}>{field.label}{field.type === "boolean" ? <input type="checkbox" checked={Boolean(value)} onChange={event => mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: event.target.checked } }, nodeTypes))} /> : field.type === "enum" ? <select value={String(value ?? field.default ?? "")} onChange={event => mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: event.target.value } }, nodeTypes))}>{value !== undefined && !field.enumValues?.includes(String(value)) && <option value={String(value)}>{String(value)} {t("(legacy)")}</option>}{field.enumValues?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input type={field.type === "number" ? "number" : "text"} value={String(value ?? field.default ?? "")} onChange={event => { if (field.type === "number") { const parsed = Number(event.target.value); if (event.target.value === "" || !Number.isFinite(parsed)) return; mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: parsed } }, nodeTypes)); return; } mutate(studioReducer(activeState, { type: "update-params", nodeId: selected.id, parameters: { ...selected.parameters, [field.name]: event.target.value } }, nodeTypes)); }} />}</label>; })}<button className="secondary-button danger" onClick={() => mutate(studioReducer(activeState, { type: "remove-node", nodeId: selected.id }, nodeTypes))}><Trash2 size={14} />{t("Remove node")}</button><button className="secondary-button" onClick={() => mutate(studioReducer(activeState, { type: "reset" }, nodeTypes))}><RotateCcw size={14} />{t("Reset")}</button></>}
      </details>
      <CopilotPanel
        busy={busy !== undefined}
        canSubmit={activeState.draft.nodes.length > 0}
        submitBlockedReason={t("Add a node before requesting a proposal")}
        proposal={copilotProposal}
        error={copilotError}
        applyBlockedReason={copilotNeedsFork ? t("Fork before applying a proposal to a builtin seed") : ""}
        status={copilotStatus}
        onSubmit={instruction => void submitCopilot(instruction)}
        onApply={applyCopilotProposal}
        onReject={rejectCopilotProposal}
      />
      </div>
    </div>
  </section>;
}
