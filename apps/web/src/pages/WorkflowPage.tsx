import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, LoaderCircle, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { collectWorkflowGraphIssues, workflowSpecSchema, type WorkflowSource, type WorkflowSpec, type WorkflowSummary } from "@consistency/schema";
import { api } from "../api/client";
import { WorkflowGraph } from "../components/WorkflowGraph";
import { useI18n } from "../i18n";

const ANALYZER_KINDS = [
  "engine.style",
  "engine.structural",
  "engine.semantic",
  "engine.duplication",
  "engine.security",
  "tool.semgrep",
  "tool.ruff",
  "tool.eslint",
  "graph.dependency",
  "graph.schema_drift"
] as const;

const VERIFIER_KINDS = [
  "verify.unit_tests",
  "verify.build",
  "verify.syntax",
  "verify.llm_sanity"
] as const;

type AnyStep = WorkflowSpec["nodes"][number] | WorkflowSpec["verifiers"][number] | WorkflowSpec["synthesizer"];
type StepRole = "node" | "verifier" | "synthesizer";

function stepsOf(spec: WorkflowSpec): { step: AnyStep; role: StepRole }[] {
  return [
    ...spec.nodes.map(step => ({ step, role: "node" as const })),
    ...spec.verifiers.map(step => ({ step, role: "verifier" as const })),
    { step: spec.synthesizer, role: "synthesizer" as const }
  ];
}

function findStep(spec: WorkflowSpec, id: string): { step: AnyStep; role: StepRole } | undefined {
  return stepsOf(spec).find(item => item.step.id === id);
}

export function WorkflowPage() {
  const { t } = useI18n();
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [current, setCurrent] = useState<{ spec: WorkflowSpec; source: WorkflowSource } | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [withJsonError, setWithJsonError] = useState<string>();

  const loadList = useCallback(async () => {
    try {
      setSummaries(await api.workflows());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load workflows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!loading && summaries.length > 0 && current === null && error === undefined) {
      const first = summaries[0];
      if (first) void openWorkflow(first.name);
    }
  });

  async function openWorkflow(name: string) {
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    setSaveError(undefined);
    try {
      const result = await api.workflow(name);
      setCurrent({ spec: result.workflow, source: result.source });
      setSelectedId(result.workflow.nodes[0]?.id ?? result.workflow.synthesizer.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow not found");
    } finally {
      setLoading(false);
    }
  }

  function patchSpec(updater: (spec: WorkflowSpec) => WorkflowSpec) {
    setCurrent(previous => previous ? { ...previous, spec: updater(previous.spec) } : previous);
    setSaveError(undefined);
  }

  function updateStep(id: string, changes: Record<string, unknown>) {
    patchSpec(spec => ({
      ...spec,
      nodes: spec.nodes.map(step => step.id === id ? { ...step, ...changes } as WorkflowSpec["nodes"][number] : step),
      verifiers: spec.verifiers.map(step => step.id === id ? { ...step, ...changes } as WorkflowSpec["verifiers"][number] : step),
      synthesizer: spec.synthesizer.id === id ? { ...spec.synthesizer, ...changes } as WorkflowSpec["synthesizer"] : spec.synthesizer
    }));
  }

  function connectSteps(source: string, target: string) {
    patchSpec(spec => {
      const addNeed = (needs: string[]) => needs.includes(source) ? needs : [...needs, source];
      return {
        ...spec,
        nodes: spec.nodes.map(step => step.id === target ? { ...step, needs: addNeed(step.needs) } : step),
        verifiers: spec.verifiers.map(step => step.id === target ? { ...step, needs: addNeed(step.needs) } : step),
        synthesizer: spec.synthesizer.id === target
          ? { ...spec.synthesizer, needs: addNeed(spec.synthesizer.needs) }
          : spec.synthesizer
      };
    });
  }

  function addNode() {
    const id = `step-${stepsOf(current!.spec).length + 1}`;
    patchSpec(spec => ({
      ...spec,
      nodes: [...spec.nodes, {
        id,
        uses: "engine.security",
        timeoutMs: 60_000,
        continueOnError: false,
        needs: [],
        with: {}
      }]
    }));
    setSelectedId(id);
  }

  function removeStep(id: string) {
    patchSpec(spec => {
      const without = (needs: string[]) => needs.filter(need => need !== id);
      return {
        ...spec,
        nodes: spec.nodes.filter(step => step.id !== id).map(step => ({ ...step, needs: without(step.needs) })),
        verifiers: spec.verifiers.filter(step => step.id !== id).map(step => ({ ...step, needs: without(step.needs) })),
        synthesizer: { ...spec.synthesizer, needs: without(spec.synthesizer.needs) }
      };
    });
    setSelectedId(undefined);
  }

  function validationIssues(): string[] {
    if (!current) return [];
    const parsed = workflowSpecSchema.safeParse(current.spec);
    const issues = parsed.success
      ? []
      : parsed.error.issues.map(issue => `${issue.path.join(".") || "workflow"}: ${issue.message}`);
    const graphIssues = collectWorkflowGraphIssues(current.spec)
      .map(issue => `${issue.path.join(".") || "workflow"}: ${issue.message}`);
    return [...new Set([...issues, ...graphIssues])];
  }

  async function saveDraft() {
    if (!current) return;
    setSaving(true);
    setSaveError(undefined);
    setNotice(undefined);
    try {
      const parsed = workflowSpecSchema.safeParse(current.spec);
      if (!parsed.success) {
        setSaveError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
        return;
      }
      await api.saveWorkflow(parsed.data);
      setCurrent({ spec: parsed.data, source: "draft" });
      setNotice(t("Draft saved"));
      await loadList();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save draft");
    } finally {
      setSaving(false);
    }
  }

  async function resetToBuiltin() {
    if (!current) return;
    if (current.source === "draft") {
      try {
        await api.deleteWorkflow(current.spec.name);
      } catch {
        // A missing draft is fine; the builtin may still exist.
      }
      await loadList();
    }
    await openWorkflow(current.spec.name);
  }

  async function deleteDraft() {
    if (!current || current.source !== "draft") return;
    await api.deleteWorkflow(current.spec.name);
    await loadList();
    const remaining = summaries.filter(item => item.name !== current.spec.name);
    if (remaining.length > 0) {
      const first = remaining[0];
      if (first) await openWorkflow(first.name);
    } else {
      setCurrent(null);
      setSelectedId(undefined);
    }
  }

  async function newDraft() {
    const template = current?.spec ?? (await api.workflow("pr-review")).workflow;
    let name = "draft";
    let counter = 2;
    while (summaries.some(item => item.name === name)) {
      name = `draft-${counter}`;
      counter += 1;
    }
    const spec: WorkflowSpec = JSON.parse(JSON.stringify(template));
    spec.name = name;
    spec.description = t("Draft from {template}", { template: template.name });
    setCurrent({ spec, source: "draft" });
    setSelectedId(spec.nodes[0]?.id ?? spec.synthesizer.id);
    setNotice(undefined);
    setSaveError(undefined);
  }

  const selected = current && selectedId ? findStep(current.spec, selectedId) : undefined;
  const issues = useMemo(validationIssues, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="page-stack workflows-page">
    <div className="workflows-toolbar">
      <div className="workflows-title">
        <span className="panel-kicker"><GitBranch size={14} />{t("Workflow builder")}</span>
        {current && <>
          <input className="workflow-name-input" aria-label={t("Name")} value={current.spec.name} onChange={event => patchSpec(spec => ({ ...spec, name: event.target.value }))} />
          <span className={`workflow-source-badge workflow-source-${current.source}`}>{current.source === "draft" ? t("Draft") : t("Builtin")}</span>
        </>}
      </div>
      <div className="workflows-actions">
        <button className="secondary-button" type="button" onClick={() => void newDraft()}><Plus size={15} />{t("New draft")}</button>
        <button className="secondary-button" type="button" onClick={() => void resetToBuiltin()} disabled={!current}><RotateCcw size={15} />{t("Reset to builtin")}</button>
        {current?.source === "draft" && <button className="secondary-button danger" type="button" onClick={() => void deleteDraft()}><Trash2 size={15} />{t("Delete draft")}</button>}
        <button className="primary-button" type="button" onClick={() => void saveDraft()} disabled={!current || saving}>{saving ? t("Saving…") : t("Save draft")}<Save size={15} /></button>
      </div>
    </div>
    {notice && <div className="workflow-notice">{notice}</div>}
    {saveError && <div className="workflow-error">{saveError}</div>}
    {issues.length > 0 && <div className="workflow-error">{t("Validation issues")}: {issues.join("; ")}</div>}
    {error && <div className="workflow-error">{error}</div>}
    {loading ? <div className="loading-state"><LoaderCircle className="spinning" size={22} /><span>{t("Loading workflow")}</span></div> :
      current ? <div className="workflows-layout">
        <aside className="workflow-list" aria-label={t("Workflows")}>
          <h3>{t("Workflows")}</h3>
          {summaries.map(item => <button key={`${item.source}-${item.name}`} type="button" className={current.spec.name === item.name ? "active" : ""} onClick={() => void openWorkflow(item.name)}>
            <strong>{item.name}</strong>
            <span className={`workflow-source-badge workflow-source-${item.source}`}>{item.source === "draft" ? t("Draft") : t("Builtin")}</span>
            <small>{item.description ?? `${item.nodeCount} ${t("nodes")} · ${item.verifierCount} ${t("verifiers")}`}</small>
          </button>)}
          <button className="workflow-add" type="button" onClick={() => void newDraft()}><Plus size={15} />{t("New draft")}</button>
        </aside>
        <main className="workflow-canvas"><WorkflowGraph spec={current.spec} selectedId={selectedId} onSelect={setSelectedId} onConnectSteps={connectSteps} /></main>
        <aside className="workflow-inspector">
          {!selected ? <div className="empty-inline">{t("Select a step to edit it.")}</div> : <WorkflowStepInspector
            key={selected.step.id}
            step={selected.step}
            role={selected.role}
            allSteps={stepsOf(current.spec)}
            onChange={updateStep}
            onRemove={selected.role === "synthesizer" ? undefined : removeStep}
            withJsonError={withJsonError}
            setWithJsonError={setWithJsonError}
          />}
          {selected && selected.role !== "synthesizer" && <button className="secondary-button workflow-add-step" type="button" onClick={addNode}><Plus size={15} />{t("Add analyzer node")}</button>}
        </aside>
      </div> : <div className="empty-state">{t("No workflows available.")}</div>}
    <p className="workflow-hint">{t("Custom workflows are saved locally under .consistency/workflows and never modify builtin YAML.")}</p>
  </div>;
}

function WorkflowStepInspector({ step, role, allSteps, onChange, onRemove, withJsonError, setWithJsonError }: {
  step: AnyStep;
  role: StepRole;
  allSteps: { step: AnyStep; role: StepRole }[];
  onChange: (id: string, changes: Record<string, unknown>) => void;
  onRemove?: (id: string) => void;
  withJsonError?: string;
  setWithJsonError: (value?: string) => void;
}) {
  const { t } = useI18n();
  const kinds = role === "node" ? ANALYZER_KINDS : role === "verifier" ? VERIFIER_KINDS : ["synthesize.review_report"];
  const [withText, setWithText] = useState(() => JSON.stringify(step.with ?? {}, null, 2));

  return <div className="workflow-inspector-body">
    <h3>{t(role === "node" ? "Analyzer" : role === "verifier" ? "Verifier" : "Synthesizer")} <code>{step.id}</code></h3>
    <label>{t("Step kind")}
      <select value={step.uses} onChange={event => onChange(step.id, { uses: event.target.value })}>
        {kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
      </select>
    </label>
    <label>{t("Timeout (ms)")}
      <input type="number" min={1_000} max={600_000} step={1_000} value={step.timeoutMs} onChange={event => onChange(step.id, { timeoutMs: Number(event.target.value) })} />
    </label>
    {role !== "synthesizer" && <label className="workflow-check"><input type="checkbox" checked={"continueOnError" in step && step.continueOnError} onChange={event => onChange(step.id, { continueOnError: event.target.checked })} />{t("Continue on error")}</label>}
    <fieldset className="workflow-needs"><legend>{t("Needs")}</legend>
      {allSteps.filter(item => item.step.id !== step.id).map(item => <label className="workflow-check" key={item.step.id}>
        <input type="checkbox" checked={step.needs.includes(item.step.id)} onChange={event => {
          const needs = event.target.checked
            ? [...step.needs, item.step.id]
            : step.needs.filter(need => need !== item.step.id);
          onChange(step.id, { needs });
        }} />
        <code>{item.step.id}</code>
      </label>)}
    </fieldset>
    <label>{t("With (JSON)")}
      <textarea rows={5} value={withText} onChange={event => {
        setWithText(event.target.value);
        try {
          const parsed = JSON.parse(event.target.value);
          onChange(step.id, { with: parsed });
          setWithJsonError(undefined);
        } catch {
          setWithJsonError(t("Invalid JSON"));
        }
      }} />
    </label>
    {withJsonError && <small className="workflow-error">{withJsonError}</small>}
    {onRemove && <button className="secondary-button danger" type="button" onClick={() => onRemove(step.id)}><Trash2 size={15} />{t("Remove step")}</button>}
  </div>;
}
