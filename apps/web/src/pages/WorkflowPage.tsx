import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CalendarClock,
  CheckCircle2,
  GitBranch,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  Radio,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Workflow
} from "lucide-react";
import {
  collectWorkflowGraphIssues,
  workflowSpecSchema,
  type AuditCapabilities,
  type Automation,
  type Repository,
  type WorkflowSource,
  type WorkflowSpec,
  type WorkflowSummary,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeDryLoadResult,
  type WorkflowRuntimeNodeType,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeRunV2,
  type WorkflowRuntimeValidationResult
} from "@consistency/schema";
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

function triggerLabel(automation: Automation, zh: boolean): string {
  if (automation.trigger.type === "manual") return zh ? "手动触发" : "Manual";
  if (automation.trigger.type === "schedule") return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  return automation.trigger.eventTypes.join(" · ");
}

function WorkflowTriggersView({
  automations = [],
  repositories = [],
  capabilities,
  actionError,
  changingAutomationId,
  onSetEnabled,
  zh
}: {
  automations?: Automation[];
  repositories?: Repository[];
  capabilities?: AuditCapabilities;
  actionError?: string;
  changingAutomationId?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
  zh: boolean;
}) {
  return (
    <div className="workflow-triggers-view page-stack">
      <section className="section-block automation-compact-empty">
        <div className="compact-empty-head">
          <CalendarClock size={20} className="empty-icon" />
          <div>
            <h3>{zh ? "触发器能力与策略" : "Trigger Capabilities & Policies"}</h3>
            <p>{zh ? "控制工作流何时以及如何自动或手动启动审查。" : "Control when and how workflows execute automatically or manually."}</p>
          </div>
        </div>

        <div className="automation-triggers-summary">
          <div className="trigger-status-item">
            <CheckCircle2 size={14} className="icon-success" />
            <span>{zh ? "手动与公开 PR 审查 (可用)" : "Manual & Public PR Reviews (Available)"}</span>
          </div>
          <div className="trigger-status-item">
            <CheckCircle2 size={14} className="icon-success" />
            <span>{zh ? "GitHub Webhook 触发 (可用)" : "GitHub Webhooks (Available)"}</span>
          </div>
          <div className="trigger-status-item muted">
            <Radio size={14} />
            <span>{zh ? "定时计划（后续里程碑）" : "Scheduled Cron (Roadmap)"}</span>
          </div>
        </div>
      </section>

      {actionError && (
        <div className="route-query-notice" role="alert">
          <strong>{zh ? "无法更新自动化策略" : "Could not update automation policy"}</strong>
          <span>{actionError}</span>
        </div>
      )}

      <section className="section-block automation-registry">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "策略绑定" : "Policy Bindings"}</span>
            <h2>{zh ? "已配置触发策略" : "Configured Trigger Bindings"}</h2>
          </div>
          <span className={capabilities?.automationScheduling ? "capability-state ready" : "capability-state pending"}>
            {capabilities?.automationScheduling ? (zh ? "调度就绪" : "Scheduler ready") : (zh ? "仅保存定义" : "Definitions only")}
          </span>
        </div>

        {automations.length > 0 ? (
          <div className="automation-list" role="list">
            {automations.map(automation => {
              const repository = repositories.find(candidate => candidate.id === automation.repositoryId);
              return (
                <article className="automation-row" role="listitem" key={automation.id}>
                  <span className={automation.enabled ? "automation-state enabled" : "automation-state"}>
                    <i />{automation.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已暂停" : "Paused")}
                  </span>
                  <div>
                    <strong>{automation.name}</strong>
                    <small>{repository?.displayName ?? automation.repositoryId}</small>
                  </div>
                  <span><CalendarClock size={14} />{triggerLabel(automation, zh)}</span>
                  <span><ShieldCheck size={14} />{automation.executionProfile === "static_readonly" ? (zh ? "静态只读" : "Static read-only") : (zh ? "受信沙箱" : "Trusted sandbox")}</span>
                  {onSetEnabled && (
                    <button
                      type="button"
                      disabled={changingAutomationId === automation.id}
                      onClick={() => onSetEnabled(automation, !automation.enabled)}
                      className="secondary-button btn-small"
                    >
                      {automation.enabled ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
                      {automation.enabled ? (zh ? "暂停" : "Pause") : (zh ? "恢复" : "Resume")}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-inline-compact">
            {zh ? "暂无绑定的仓库触发策略。通过 GitHub App Webhook 或手动审查执行工作流。" : "No repository trigger bindings configured yet. Workflows execute on GitHub webhooks or manual review."}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Minimal CKPT3 Phase 2 control: persisted definitions (builtin seed + user
 * drafts with append-only revisions), dry-load feasibility (compile-sourced,
 * explicitly NOT an authorization), revision-pinned triggers on a registered
 * repository, and persisted run history. No canvas, no redesign.
 */
function WorkflowRuntimeView({ zh }: { zh: boolean }) {
  const [overview, setOverview] = useState<{ definition: WorkflowRuntimeDefinition; nodeTypes: WorkflowRuntimeNodeType[] } | null>(null);
  const [definitions, setDefinitions] = useState<WorkflowRuntimeDefinitionSummary[] | null>(null);
  const [definitionsUnavailable, setDefinitionsUnavailable] = useState(false);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string>("");
  const [selectedRevision, setSelectedRevision] = useState<WorkflowRuntimeDefinitionRevision | null>(null);
  const [definitionText, setDefinitionText] = useState("");
  const [validation, setValidation] = useState<{ ok: boolean; errors: { code: string; message: string }[] } | null>(null);
  const [validating, setValidating] = useState(false);
  const [dryLoad, setDryLoad] = useState<WorkflowRuntimeDryLoadResult | null>(null);
  const [saveNotice, setSaveNotice] = useState<string>();
  const [saveError, setSaveError] = useState<string>();

  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [repositoriesUnavailable, setRepositoriesUnavailable] = useState(false);
  const [repositoryId, setRepositoryId] = useState<string>("");
  const [triggering, setTriggering] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [run, setRun] = useState<WorkflowRuntimeRunV2 | null>(null);
  const [runs, setRuns] = useState<WorkflowRuntimeRunSummary[]>([]);

  const loadDefinitions = useCallback(async () => {
    try {
      const result = await api.workflowRuntimeDefinitions();
      setDefinitions(result);
      if (!selectedDefinitionId && result.length > 0) setSelectedDefinitionId(result[0]!.definitionId);
    } catch {
      setDefinitionsUnavailable(true);
    }
  }, [selectedDefinitionId]);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await api.workflowRuntimeRuns());
    } catch {
      // history list is best-effort in the view; failures surface on detail
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.workflowRuntimeOverview().then(result => {
      if (cancelled) return;
      setOverview(result);
    }).catch(() => undefined);
    void api.repositories().then(result => {
      if (cancelled) return;
      setRepositories(result);
      const first = result.find(candidate => candidate.source === "local_git") ?? result[0];
      if (first) setRepositoryId(first.id);
    }).catch(() => {
      if (!cancelled) setRepositoriesUnavailable(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { void loadDefinitions(); }, [loadDefinitions]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);

  async function openRevision(definitionId: string) {
    setSelectedDefinitionId(definitionId);
    setValidation(null);
    setDryLoad(null);
    setSaveNotice(undefined);
    setSaveError(undefined);
    const builtIn = await api.workflowRuntimeOverview();
    try {
      const defs = await api.workflowRuntimeDefinitions();
      const summary = defs.find(candidate => candidate.definitionId === definitionId);
      if (summary?.origin === "builtin" || !summary?.latestRevisionId) {
        setSelectedRevision(null);
        setDefinitionText(JSON.stringify(builtIn.definition, null, 2));
        return;
      }
      const revision = await api.workflowRuntimeRevision(definitionId, summary.latestRevisionId);
      setSelectedRevision(revision);
      setDefinitionText(JSON.stringify(revision.definition, null, 2));
    } catch {
      // List/revision read failed: fall back to the builtin template so the
      // editor stays usable; failures surface on save/validate.
      const template = JSON.parse(JSON.stringify(builtIn.definition)) as WorkflowRuntimeDefinition;
      template.id = definitionId;
      setSelectedRevision(null);
      setDefinitionText(JSON.stringify(template, null, 2));
    }
  }

  async function validateDefinition() {
    setValidating(true);
    setValidation(null);
    try {
      const parsed = JSON.parse(definitionText) as unknown;
      const result = await api.validateWorkflowRuntime(parsed);
      setValidation({ ok: result.ok, errors: result.errors.map(issue => ({ code: issue.code, message: issue.message })) });
    } catch (caught) {
      setValidation({
        ok: false,
        errors: [{ code: "parse", message: caught instanceof Error ? caught.message : "Invalid JSON" }]
      });
    } finally {
      setValidating(false);
    }
  }

  async function saveRevision() {
    setSaveNotice(undefined);
    setSaveError(undefined);
    try {
      const parsed = JSON.parse(definitionText) as WorkflowRuntimeDefinition;
      const revision = await api.saveWorkflowRuntimeDefinition({
        ...(selectedDefinitionId && selectedDefinitionId !== parsed.id ? { definitionId: selectedDefinitionId } : {}),
        definition: parsed
      });
      setSelectedDefinitionId(revision.definitionId);
      setSelectedRevision(revision);
      setSaveNotice(
        zh
          ? `已保存 revision ${revision.revision}（${revision.status === "validated" ? "可执行" : "草稿（含校验问题，不可执行）"}）`
          : `Saved revision ${revision.revision} (${revision.status === "validated" ? "executable" : "draft with issues (not executable)"})`
      );
      await loadDefinitions();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save the definition");
    }
  }

  async function runDryLoad() {
    setDryLoad(null);
    try {
      if (selectedRevision) {
        setDryLoad(await api.workflowRuntimeDryLoad(selectedRevision.definitionId, selectedRevision.revisionId));
        return;
      }
      const parsed = JSON.parse(definitionText) as WorkflowRuntimeDefinition;
      const revision = await api.saveWorkflowRuntimeDefinition({ definition: parsed });
      setSelectedRevision(revision);
      setDryLoad(await api.workflowRuntimeDryLoad(revision.definitionId, revision.revisionId));
      await loadDefinitions();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Dry-load failed");
    }
  }

  async function triggerRun() {
    setTriggering(true);
    setRunError(undefined);
    setRun(null);
    try {
      const pin = selectedRevision && selectedRevision.definitionId !== "verified-mini-review"
        ? { definitionId: selectedRevision.definitionId, revisionId: selectedRevision.revisionId }
        : undefined;
      const created = await api.triggerWorkflowRuntime(repositoryId, pin);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await api.workflowRuntimeRunV2(created.runId);
        setRun(current);
        if (current.status !== "running") {
          await loadRuns();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      setRunError(zh ? "等待运行结束超时" : "Timed out waiting for the run to finish");
    } catch (caught) {
      setRunError(caught instanceof Error ? caught.message : "Workflow run failed");
    } finally {
      setTriggering(false);
    }
  }

  const isBuiltinSelected = definitions?.find(d => d.definitionId === selectedDefinitionId)?.origin === "builtin";

  return (
    <div className="page-stack workflow-runtime-view">
      <section className="section-block">
        <div className="panel-title">
          <div>
            <span className="panel-kicker"><ShieldCheck size={14} />{zh ? "已验证运行时（持久化）" : "Verified runtime (persisted)"}</span>
            <h2>{zh ? "定义 · Dry-load · Run 历史" : "Definitions · Dry-load · Run history"}</h2>
          </div>
        </div>
        <p className="muted-note">
          {zh
            ? "定义以 append-only revision 持久化；执行始终 pin 具体 revision 并绑定已注册仓库的 HEAD 快照（SHA 钉定）。Dry-load 是编译期可行性检查，不构成任何运行时授权；每个受保护操作在执行时逐 syscall 经 Kernel 授权。"
            : "Definitions persist as append-only revisions; execution always pins a specific revision and a registered repository's SHA-pinned HEAD snapshot. Dry-load is a compile-time FEASIBILITY check — it is NOT an authorization; every protected operation is authorized per-syscall by the Kernel at execution time."}
        </p>
        {overview && (
          <div className="automation-triggers-summary">
            {overview.nodeTypes.map(nodeType => (
              <div className="trigger-status-item" key={nodeType.type}>
                <CheckCircle2 size={14} className="icon-success" />
                <span>{nodeType.type} · {nodeType.capabilityRequirements.join(" + ")}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "定义" : "Definitions"}</span>
            <h2>{zh ? "定义列表与编辑" : "Definitions & editor"}</h2>
          </div>
          <div className="workflows-actions">
            <button type="button" className="secondary-button btn-small" disabled={validating} onClick={() => void validateDefinition()}>
              {validating ? <LoaderCircle size={13} className="spin" /> : <CheckCircle2 size={13} />}
              {zh ? "校验" : "Validate"}
            </button>
            <button type="button" className="secondary-button btn-small" onClick={() => void saveRevision()} disabled={isBuiltinSelected}>
              <Save size={13} />
              {zh ? "保存 revision" : "Save revision"}
            </button>
            <button type="button" className="secondary-button btn-small" onClick={() => void runDryLoad()}>
              <ShieldCheck size={13} />
              {zh ? "Dry-load" : "Dry-load"}
            </button>
          </div>
        </div>
        {definitionsUnavailable ? (
          <div className="route-query-notice" role="alert">
            <strong>{zh ? "定义列表不可用" : "Definitions unavailable"}</strong>
          </div>
        ) : definitions !== null && definitions.length === 0 ? (
          <div className="empty-inline-compact">
            {zh ? "尚无持久化定义（空 ≠ 不可用）。内置定义在服务启动时播种。" : "No persisted definitions yet (empty, not unavailable). The builtin seed appears after server startup."}
          </div>
        ) : (
          <div className="workflow-runtime-inputs">
            <select
              aria-label={zh ? "选择定义" : "Definition"}
              value={selectedDefinitionId}
              onChange={event => void openRevision(event.target.value)}
            >
              {(definitions ?? []).map(summary => (
                <option key={summary.definitionId} value={summary.definitionId}>
                  {summary.definitionId} · {summary.origin === "builtin" ? (zh ? "内置" : "builtin") : zh ? "用户" : "user"}
                  {summary.latestRevision !== null ? ` · r${summary.latestRevision} ${summary.status === "validated" ? "✓" : "!"}` : ""}
                </option>
              ))}
            </select>
            {isBuiltinSelected && (
              <p className="muted-note">{zh ? "内置定义不可变；编辑并保存会创建新的用户定义。" : "The builtin definition is immutable; editing + saving creates a new user definition."}</p>
            )}
            {selectedRevision && (
              <p className="muted-note">
                {zh ? `当前 revision：r${selectedRevision.revision}（${selectedRevision.revisionId.slice(0, 14)}…）· ${selectedRevision.status === "validated" ? "可执行" : "草稿（不可执行）"}` : `Pinned revision r${selectedRevision.revision} (${selectedRevision.revisionId.slice(0, 14)}…) · ${selectedRevision.status}`}
              </p>
            )}
            <textarea
              className="workflow-runtime-definition-input"
              spellCheck={false}
              rows={10}
              aria-label={zh ? "工作流定义 JSON" : "Workflow definition JSON"}
              value={definitionText}
              onChange={event => setDefinitionText(event.target.value)}
            />
          </div>
        )}
        {validation && (
          <div className={validation.ok ? "route-query-notice notice-success" : "route-query-notice"} role="status">
            <strong>{validation.ok ? (zh ? "校验通过" : "Validation passed") : (zh ? "校验失败（fail-closed）" : "Validation failed (fail-closed)")}</strong>
            {validation.errors.length > 0 && (
              <ul className="workflow-runtime-errors">
                {validation.errors.map((issue, index) => <li key={index}>{issue.code}: {issue.message}</li>)}
              </ul>
            )}
          </div>
        )}
        {saveNotice && <div className="route-query-notice notice-success" role="status"><span>{saveNotice}</span></div>}
        {saveError && <div className="route-query-notice" role="alert"><span>{saveError}</span></div>}
        {dryLoad && (
          <div className={dryLoad.overall === "feasible" ? "route-query-notice notice-success" : "route-query-notice"} role="status">
            <strong>
              {dryLoad.overall === "feasible"
                ? (zh ? "可行（feasible）" : "Feasible")
                : (zh ? "不可行（not-feasible）" : "Not feasible")}
              {zh ? " — 编译期可行性检查，不构成运行时授权" : " — compile-time feasibility, NOT an authorization"}
            </strong>
            <ul className="workflow-runtime-errors">
              {dryLoad.nodes.map(node => (
                <li key={node.nodeId}>
                  {node.nodeTypeRegistered && node.serviceRefMatches && node.coeffects.every(c => c.available) && node.capabilityRequirements.every(r => r.satisfiable) ? "✓" : "✗"}{" "}
                  {node.nodeId} ({node.nodeType}) ·{" "}
                  {node.nodeTypeRegistered ? "" : (zh ? "节点类型未注册；" : "node type not registered; ")}
                  {!node.serviceRefMatches && node.nodeTypeRegistered ? (zh ? "serviceRef 不匹配；" : "serviceRef mismatch; ") : ""}
                  {node.coeffects.filter(c => !c.available).map(c => `${c.name} ✗`).join(" ")}
                  {node.capabilityRequirements.filter(r => !r.satisfiable).map(r => `${r.action} ✗`).join(" ")}
                  {node.issues.map(issue => issue.message).join("; ")}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "执行" : "Execution"}</span>
            <h2>{zh ? "绑定已注册仓库触发（pin 当前 revision）" : "Trigger on a registered repository (pins the current revision)"}</h2>
          </div>
          <button type="button" className="secondary-button btn-small" disabled={triggering || repositoryId.length === 0} onClick={() => void triggerRun()}>
            {triggering ? <LoaderCircle size={13} className="spin" /> : <PlayCircle size={13} />}
            {zh ? "运行" : "Run"}
          </button>
        </div>
        {repositoriesUnavailable ? (
          <div className="route-query-notice" role="alert">
            <strong>{zh ? "仓库列表不可用" : "Repository list unavailable"}</strong>
          </div>
        ) : repositories !== null && repositories.length === 0 ? (
          <div className="empty-inline-compact">
            {zh ? "尚无已注册仓库（空 ≠ 不可用）。请先在「代码仓库」页连接本地 Git 仓库。" : "No repositories registered yet (empty, not unavailable). Connect one on the Repositories page first."}
          </div>
        ) : (
          <div className="workflow-runtime-inputs">
            <select aria-label={zh ? "选择仓库" : "Repository"} value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>
              {(repositories ?? []).map(repository => (
                <option key={repository.id} value={repository.id}>
                  {repository.displayName} ({repository.source === "local_git" ? (zh ? "本地" : "local") : repository.source})
                </option>
              ))}
            </select>
          </div>
        )}
        {runError && <div className="route-query-notice" role="alert"><strong>{zh ? "运行失败" : "Run failed"}</strong><span>{runError}</span></div>}
        {run && (
          <div className="workflow-runtime-result">
            <div className="trigger-status-item">
              {run.status === "succeeded" ? <CheckCircle2 size={14} className="icon-success" /> : <Radio size={14} />}
              <span>
                {zh ? "Run 状态" : "Run status"}: {run.status} · {run.evidence.length} {zh ? "条 Evidence" : "evidence"}
                {run.miniReport ? ` · ${run.miniReport.audit.allowed} allow / ${run.miniReport.audit.denied} deny` : ""}
                {" · "}{run.origin} {run.revisionId.slice(0, 14)}…
              </span>
            </div>
            <div className="trigger-status-item">
              <GitBranch size={14} />
              <span>{run.snapshot.repository} @ {run.snapshot.headSha.slice(0, 12)}</span>
            </div>
            {run.trigger && (
              <div className="trigger-status-item">
                <ShieldCheck size={14} />
                <span>
                  {run.trigger.source === "repository_change"
                    ? zh ? "变更触发" : "Change-triggered"
                    : zh ? "手动触发" : "Manual"}
                  {run.trigger.eventId ? ` · ${run.trigger.eventId.slice(0, 24)}…` : ""}
                </span>
              </div>
            )}
            {run.evidence.length > 0 && (
              <ul className="workflow-runtime-evidence">
                {run.evidence.map(record => (
                  <li key={record.id}>
                    <code>{record.ruleId ?? record.source}</code> {record.path}
                    {record.startLine ? `:${record.startLine}` : ""} · <code className="fingerprint">{record.fingerprint.slice(0, 12)}</code>
                  </li>
                ))}
              </ul>
            )}
            {run.miniReport && run.miniReport.findings.length > 0 && (
              <ul className="workflow-runtime-findings">
                {run.miniReport.findings.map(finding => (
                  <li key={finding.id}><strong>{finding.file}</strong> — {finding.title}</li>
                ))}
              </ul>
            )}
            {run.error && <p className="muted-note">{run.error}</p>}
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "历史" : "History"}</span>
            <h2>{zh ? "Run 历史（持久化）" : "Run history (persisted)"}</h2>
          </div>
          <button type="button" className="secondary-button btn-small" onClick={() => void loadRuns()}>
            <RotateCcw size={13} />
            {zh ? "刷新" : "Refresh"}
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="empty-inline-compact">{zh ? "暂无 run 历史（空 ≠ 不可用）。" : "No run history yet (empty, not unavailable)."}</div>
        ) : (
          <div className="automation-list" role="list">
            {runs.map(summary => (
              <article className="automation-row" role="listitem" key={summary.runId}>
                <span className={summary.status === "succeeded" ? "automation-state enabled" : "automation-state"}>
                  <i />{summary.status}
                </span>
                <div>
                  <strong>{summary.definitionId}</strong>
                  <small>
                    {summary.revisionId.slice(0, 14)}… · {summary.repository}
                    {summary.trigger ? ` · ${summary.trigger.source === "repository_change" ? (zh ? "变更触发" : "change") : zh ? "手动" : "manual"}` : ""}
                  </small>
                </div>
                <span>{summary.evidenceCount} ev · {summary.findingCount} {zh ? "发现" : "findings"}</span>
                <span>{new Date(summary.createdAt).toLocaleString()}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
export function WorkflowPage({
  automations = [],
  repositories = [],
  capabilities,
  actionError,
  changingAutomationId,
  onSetEnabled
}: {
  automations?: Automation[];
  repositories?: Repository[];
  capabilities?: AuditCapabilities;
  actionError?: string;
  changingAutomationId?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
} = {}) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab =
    searchParams.get("tab") === "triggers" ? "triggers"
      : searchParams.get("tab") === "runtime" ? "runtime"
        : "definition";
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
    <div className="workflow-sub-nav" role="tablist" aria-label={t("Workflow views")}>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "definition"}
        className={`workflow-tab ${activeTab === "definition" ? "active" : ""}`}
        onClick={() => setSearchParams({})}
      >
        <Workflow size={14} />
        {zh ? "工作流定义" : "Definitions"}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "triggers"}
        className={`workflow-tab ${activeTab === "triggers" ? "active" : ""}`}
        onClick={() => setSearchParams({ tab: "triggers" })}
      >
        <CalendarClock size={14} />
        {zh ? "触发器与策略" : "Triggers"}
        {automations.length > 0 && <span className="tab-count">({automations.length})</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "runtime"}
        className={`workflow-tab ${activeTab === "runtime" ? "active" : ""}`}
        onClick={() => setSearchParams({ tab: "runtime" })}
      >
        <ShieldCheck size={14} />
        {zh ? "已验证运行时" : "Verified runtime"}
      </button>
    </div>

    {activeTab === "triggers" ? (
      <WorkflowTriggersView
        automations={automations}
        repositories={repositories}
        capabilities={capabilities}
        actionError={actionError}
        changingAutomationId={changingAutomationId}
        onSetEnabled={onSetEnabled}
        zh={zh}
      />
    ) : activeTab === "runtime" ? (
      <WorkflowRuntimeView zh={zh} />
    ) : (
      <>
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
      </>
    )}
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
