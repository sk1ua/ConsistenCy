import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CalendarClock,
  CheckCircle2,
  GitBranch,
  Inbox,
  PauseCircle,
  Pencil,
  PlayCircle,
  Radio,
  RotateCcw,
  Save,
  SearchCode,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import {
  type AuditCapabilities,
  type Automation,
  type Repository,
  type ReviewJob,
  type WorkflowRuntimeDefinition,
  type WorkflowRuntimeDefinitionRevision,
  type WorkflowRuntimeDefinitionSummary,
  type WorkflowRuntimeDryLoadResult,
  type WorkflowRuntimeNodeType,
  type WorkflowRuntimeRunSummary,
  type WorkflowRuntimeRunV2
} from "@consistency/schema";
import { api } from "../api/client";
import { Button } from "../design-system/Button";
import { WorkflowXRayView } from "../routes/WorkflowXRayView";
import { ReviewWizardDialog } from "../routes/ReviewWizardDialog";
import { WorkflowDefinitionDialog } from "../routes/WorkflowDefinitionDialog";
import { WorkflowExecutionDialog } from "../routes/WorkflowExecutionDialog";
import { RuntimeStudio } from "../studio/RuntimeStudio";
import { useI18n } from "../i18n";

function triggerLabel(automation: Automation, zh: boolean): string {
  if (automation.trigger.type === "manual") return zh ? "手动触发" : "Manual";
  if (automation.trigger.type === "schedule") return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  return automation.trigger.eventTypes.join(" · ");
}

function adjustWorkflowTabRail(tab: HTMLButtonElement): void {
  const rail = tab.parentElement;
  if (!rail || !rail.classList.contains("workflow-sub-nav")) return;
  const tabRect = tab.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  if (tabRect.left < railRect.left) rail.scrollLeft -= railRect.left - tabRect.left;
  else if (tabRect.right > railRect.right) rail.scrollLeft += tabRect.right - railRect.right;
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
    <div className="workflow-triggers-view page-stack ds-page">
      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <h3 className="ds-section-title">
              <CalendarClock size={16} />
              {zh ? "触发器能力与策略" : "Trigger Capabilities & Policies"}
            </h3>
            <p className="ds-section-description">{zh ? "控制工作流何时以及如何自动或手动启动审查。" : "Control when and how workflows execute automatically or manually."}</p>
          </div>
        </div>

        <div className="ds-chip-row">
          <span className="ds-chip ds-chip--ok">
            <CheckCircle2 size={12} />
            <span>{zh ? "手动与公开 PR 审查 (可用)" : "Manual & Public PR Reviews (Available)"}</span>
          </span>
          <span className="ds-chip ds-chip--ok">
            <CheckCircle2 size={12} />
            <span>{zh ? "GitHub Webhook 触发 (可用)" : "GitHub Webhooks (Available)"}</span>
          </span>
          <span className="ds-chip ds-chip--muted">
            <Radio size={12} />
            <span>{zh ? "定时计划（后续里程碑）" : "Scheduled Cron (Roadmap)"}</span>
          </span>
        </div>
      </section>

      {actionError && (
        <div className="route-query-notice" role="alert">
          <strong>{zh ? "无法更新自动化策略" : "Could not update automation policy"}</strong>
          <span>{actionError}</span>
        </div>
      )}

      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker">{zh ? "策略绑定" : "Policy Bindings"}</span>
            <h2 className="ds-section-title">{zh ? "已配置触发策略" : "Configured Trigger Bindings"}</h2>
          </div>
          <span className={capabilities?.automationScheduling ? "ds-chip ds-chip--ok" : "ds-chip ds-chip--muted"}>
            {capabilities?.automationScheduling ? (zh ? "调度就绪" : "Scheduler ready") : (zh ? "仅保存定义" : "Definitions only")}
          </span>
        </div>

        {automations.length > 0 ? (
          <div className="ds-row-list" role="list">
            {automations.map(automation => {
              const repository = repositories.find(candidate => candidate.id === automation.repositoryId);
              return (
                <article className="ds-row" role="listitem" key={automation.id}>
                  <span className={automation.enabled ? "ds-chip ds-chip--ok" : "ds-chip ds-chip--muted"}>
                    <i />{automation.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已暂停" : "Paused")}
                  </span>
                  <div className="ds-row-main">
                    <strong className="ds-row-title">{automation.name}</strong>
                    <small className="ds-row-sub">{repository?.displayName ?? automation.repositoryId}</small>
                  </div>
                  <span className="ds-row-meta"><CalendarClock size={13} />{triggerLabel(automation, zh)}</span>
                  <span className="ds-row-meta"><ShieldCheck size={13} />{automation.executionProfile === "static_readonly" ? (zh ? "静态只读" : "Static read-only") : (zh ? "受信沙箱" : "Trusted sandbox")}</span>
                  {onSetEnabled && (
                    <span className="ds-row-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={changingAutomationId === automation.id}
                        onClick={() => onSetEnabled(automation, !automation.enabled)}
                      >
                        {automation.enabled ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
                        {automation.enabled ? (zh ? "暂停" : "Pause") : (zh ? "恢复" : "Resume")}
                      </Button>
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="ds-empty ds-empty--slim">
            <span className="ds-empty-icon"><Inbox size={20} /></span>
            <p className="ds-empty-text">{zh ? "暂无绑定的仓库触发策略。通过 GitHub App Webhook 或手动审查执行工作流。" : "No repository trigger bindings configured yet. Workflows execute on GitHub webhooks or manual review."}</p>
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
 * repository, and persisted run history. The legacy definition builder has
 * been removed; the runtime-native graph Studio is isolated in RuntimeStudio
 * and is not a legacy redesign.
 *
 * Dialog-first IA: the page surface is a management view (current-definition
 * hero summary + single gate row with Studio next-action semantics + inline run
 * history); definition authoring (select / JSON editor / validation feedback /
 * save revision) lives in WorkflowDefinitionDialog and execution configuration
 * (repository binding + run) in WorkflowExecutionDialog. All state and handlers
 * stay in this component; the dialogs are shells over the same API calls and
 * enablement rules — no new API calls, write paths, or permissions.
 */
function WorkflowRuntimeView({ zh }: { zh: boolean }) {
  const { t } = useI18n();
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
  // Stale-validation guard (audit follow-up): a validation verdict is bound to
  // the exact definition text it judged (mirrors the dry-load revisionId
  // binding). Editing the draft afterwards re-arms the validate gate instead of
  // letting the page trust an outdated verdict.
  const [lastValidatedText, setLastValidatedText] = useState<string>();
  // Editor-load generation: out-of-order responses from rapid definition
  // switches must never overwrite the text of the newest selection.
  const revisionLoadGeneration = useRef(0);

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

  /**
   * Load the SELECTED definition's own persisted latest revision into the
   * editor (P1 fix). The previous implementation fell back to overview()'s
   * canonical definition for every builtin, so the editor showed
   * verified-mini-review JSON regardless of the selection, and the dialog's
   * initially selected definition was never loaded at all. Every definition —
   * builtin seeds included — has a persisted revision (trusted host seed), so
   * one uniform revision load serves the editor text and the pinned revision
   * from the same source. The text is cleared up-front: a load failure or an
   * in-flight switch never leaves another definition's content behind.
   */
  async function openRevision(definitionId: string) {
    setSelectedDefinitionId(definitionId);
    setValidation(null);
    setDryLoad(null);
    setSaveNotice(undefined);
    setSaveError(undefined);
    setSelectedRevision(null);
    setDefinitionText("");
    const requestGeneration = ++revisionLoadGeneration.current;
    try {
      const defs = await api.workflowRuntimeDefinitions();
      if (requestGeneration !== revisionLoadGeneration.current) return;
      const summary = defs.find(candidate => candidate.definitionId === definitionId);
      if (!summary?.latestRevisionId) {
        setSaveError(zh ? `「${definitionId}」没有可加载的持久化 revision` : `"${definitionId}" has no persisted revision to load`);
        return;
      }
      const revision = await api.workflowRuntimeRevision(definitionId, summary.latestRevisionId);
      if (requestGeneration !== revisionLoadGeneration.current) return;
      setSelectedRevision(revision);
      setDefinitionText(JSON.stringify(revision.definition, null, 2));
    } catch {
      if (requestGeneration !== revisionLoadGeneration.current) return;
      setSaveError(zh ? `加载「${definitionId}」的持久化 revision 失败` : `Could not load the persisted revision of "${definitionId}"`);
    }
  }

  async function validateDefinition() {
    setValidating(true);
    setValidation(null);
    const requestText = definitionText;
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
      setLastValidatedText(requestText);
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
    if (!selectedRevision) {
      setSaveError(zh ? "Dry-load 仅支持已保存 revision；请先 Validate + Save" : "Dry-load requires a persisted revision; Validate + Save first");
      return;
    }
    try {
      setDryLoad(await api.workflowRuntimeDryLoad(selectedRevision.definitionId, selectedRevision.revisionId));
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

  // Dialog-first IA: the page surface is a management view (definition summary
  // + gate row + run history); authoring and execution configuration live in
  // dialogs. This open/close state is presentation only.
  const [definitionDialogOpen, setDefinitionDialogOpen] = useState(false);
  const [executionDialogOpen, setExecutionDialogOpen] = useState(false);
  const openDefinitionDialog = () => setDefinitionDialogOpen(true);
  const openExecutionDialog = () => setExecutionDialogOpen(true);
  // The editor always shows the selected definition's own text: the dialog
  // open and every selection change (re)load that definition's latest
  // revision, including the initially auto-selected definition. Same-value
  // selections are idempotent; the generation ref in openRevision discards
  // out-of-order responses from rapid switches. openRevision intentionally
  // mirrors the current selection back (no refire via Object.is bail-out).
  useEffect(() => {
    if (!definitionDialogOpen || !selectedDefinitionId) return;
    void openRevision(selectedDefinitionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitionDialogOpen, selectedDefinitionId]);

  // Presentation-only gate sequencing (the Studio next-action semantics):
  // 校验 → 保存 revision → Dry-load → 运行, with repository binding as the run
  // precondition. Every value below derives from existing state; no handler,
  // API call, or state transition lives here. Each action keeps its existing
  // enablement rules inside the dialogs (Dry-load acts directly on the surface).
  const selectedSummary = definitions?.find(summary => summary.definitionId === selectedDefinitionId) ?? null;
  const boundRepository = repositories?.find(repository => repository.id === repositoryId) ?? null;
  // A verdict only counts while the draft is exactly the text that was judged.
  const validationIsStale = validation !== null && definitionText !== lastValidatedText;
  const validationPassed = validation?.ok === true && !validationIsStale;
  const revisionPinned = selectedRevision !== null;
  const dryLoadFeasible = dryLoad !== null && selectedRevision !== null && dryLoad.revisionId === selectedRevision.revisionId && dryLoad.overall === "feasible";
  const repositoryBound = repositoryId.length > 0;
  type RuntimeGateKey = "validate" | "save" | "dry" | "run";
  const gateOrder: (RuntimeGateKey | "repo")[] = ["validate", "save", "dry", "repo", "run"];
  const nextGate: RuntimeGateKey | "repo" = !validationPassed ? "validate"
    : !revisionPinned ? "save"
      : !dryLoadFeasible ? "dry"
        : !repositoryBound ? "repo" : "run";
  const isLaterGate = (gate: RuntimeGateKey) => gateOrder.indexOf(gate) > gateOrder.indexOf(nextGate);
  const gateChips: { key: RuntimeGateKey; label: string; glyph: string; tone: string; evidence: string }[] = [
    {
      key: "validate",
      label: zh ? "校验" : "Validate",
      glyph: validationPassed ? "✓" : validation && !validation.ok ? "!" : "●",
      tone: validationPassed ? "ds-chip--ok" : validation && !validation.ok ? "ds-chip--danger" : "ds-chip--muted",
      evidence: validationPassed
        ? (zh ? "服务端权威校验通过" : "Server validation passed")
        : validationIsStale
          ? t("Draft changed — revalidate")
          : validation && !validation.ok
            ? (zh ? "校验失败（fail-closed）" : "Validation failed (fail-closed)")
            : (zh ? "尚未校验" : "Not validated yet")
    },
    {
      key: "save",
      label: zh ? "保存 revision" : "Save revision",
      glyph: revisionPinned ? "✓" : "●",
      tone: revisionPinned ? "ds-chip--ok" : "ds-chip--muted",
      evidence: selectedRevision
        ? (zh ? `已保存 revision r${selectedRevision.revision}` : `Saved revision r${selectedRevision.revision}`)
        : (zh ? "校验通过后保存 revision" : "Save a revision after validation")
    },
    {
      key: "dry",
      label: zh ? "Dry-load" : "Dry-load",
      glyph: dryLoadFeasible ? "✓" : revisionPinned ? "●" : "○",
      tone: dryLoadFeasible ? "ds-chip--ok" : "ds-chip--muted",
      evidence: dryLoadFeasible
        ? (zh ? "Dry-load 可行" : "Dry-load feasible")
        : revisionPinned
          ? (zh ? "对已保存 revision 执行 Dry-load" : "Dry-load the saved revision")
          : (zh ? "需要已保存的 revision" : "Needs a saved revision")
    },
    {
      key: "run",
      label: zh ? "运行" : "Run",
      glyph: dryLoadFeasible && repositoryBound ? "●" : "○",
      tone: "ds-chip--muted",
      evidence: !repositoryBound
        ? (zh ? "运行前置：绑定仓库（配置执行）" : "Run precondition: bind a repository (configure execution)")
        : dryLoadFeasible
          ? (zh ? "已就绪：可运行钉住的 revision" : "Ready to run the pinned revision")
          : (zh ? "运行前置：Dry-load 可行" : "Run precondition: feasible dry-load")
    }
  ];
  const nextActionText = nextGate === "validate" ? (zh ? "下一步：校验当前定义草稿" : "Next: validate the current draft")
    : nextGate === "save" ? (zh ? "下一步：保存 revision 以钉住当前定义" : "Next: save a revision to pin the definition")
      : nextGate === "dry" ? (zh ? "下一步：对已保存 revision 执行 Dry-load" : "Next: dry-load the saved revision")
        : nextGate === "repo" ? (zh ? "下一步：绑定仓库（配置执行）" : "Next: bind a repository (configure execution)")
          : (zh ? "门禁已就绪：可运行钉住的 revision" : "Gates ready: run the pinned revision");

  return (
    <div className="page-stack workflow-runtime-view ds-page">
      <section className="ds-hero">
        <div className="ds-hero-icon"><ShieldCheck size={19} /></div>
        <div className="ds-hero-body">
          <span className="ds-section-kicker">{zh ? "已验证运行时（持久化）" : "Verified runtime (persisted)"}</span>
          <h2 className="ds-hero-title">{selectedDefinitionId || (zh ? "未选择定义" : "No definition selected")}</h2>
          <p className="ds-hero-description">
            {zh
              ? "定义以 append-only revision 持久化；执行始终 pin 具体 revision 并绑定已注册仓库的 HEAD 快照（SHA 钉定）。Dry-load 是编译期可行性检查，不构成任何运行时授权；每个受保护操作在执行时逐 syscall 经 Kernel 授权。"
              : "Definitions persist as append-only revisions; execution always pins a specific revision and a registered repository's SHA-pinned HEAD snapshot. Dry-load is a compile-time FEASIBILITY check — it is NOT an authorization; every protected operation is authorized per-syscall by the Kernel at execution time."}
          </p>
          <div className="ds-chip-row">
            {selectedSummary && (
              <span className="ds-chip ds-chip--muted" title={zh ? "当前定义来源" : "Current definition origin"}>
                {selectedSummary.origin === "builtin" ? (zh ? "来源 · 内置" : "Origin · builtin") : (zh ? "来源 · 用户" : "Origin · user")}
              </span>
            )}
            {selectedRevision ? (
              <span className={`ds-chip ${selectedRevision.status === "validated" ? "ds-chip--ok" : "ds-chip--warn"}`}>
                {zh
                  ? `revision r${selectedRevision.revision} · ${selectedRevision.status === "validated" ? "可执行" : "草稿"}`
                  : `revision r${selectedRevision.revision} · ${selectedRevision.status === "validated" ? "executable" : "draft"}`}
              </span>
            ) : (
              <span className="ds-chip ds-chip--muted">{zh ? "revision · 无" : "revision · none"}</span>
            )}
            {overview && overview.nodeTypes.map(nodeType => (
              <span className="ds-chip ds-chip--muted ds-chip--mono" key={nodeType.type}>
                <CheckCircle2 size={12} />
                <span>{nodeType.type} · {nodeType.capabilityRequirements.join(" + ")}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="ds-hero-actions">
          <Button type="button" size="sm" variant="secondary" onClick={openDefinitionDialog}>
            <Pencil size={13} />
            {zh ? "编辑定义" : "Edit definition"}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={openExecutionDialog}>
            <SlidersHorizontal size={13} />
            {zh ? "配置执行" : "Configure execution"}
          </Button>
        </div>
      </section>

      <section className="ds-section" aria-label={zh ? "执行门禁" : "Execution gates"}>
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker">{zh ? "执行门禁" : "Execution gates"}</span>
            <h2 className="ds-section-title">{zh ? "校验 → 保存 revision → Dry-load → 运行" : "Validate → Save revision → Dry-load → Run"}</h2>
          </div>
        </div>
        <div className="ds-chip-row" role="list" aria-label={zh ? "门禁状态" : "Gate status"}>
          {gateChips.map(gate => (
            <span key={gate.key} role="listitem" className={`ds-chip ${gate.tone}`} title={gate.evidence}>
              <span aria-hidden="true">{gate.glyph}</span>
              <span>{gate.label}</span>
            </span>
          ))}
          <span
            className={`ds-chip ${repositoryBound ? "ds-chip--ok" : "ds-chip--muted"}`}
            title={zh ? "运行前置：仓库绑定" : "Run precondition: repository binding"}
          >
            {repositoryBound
              ? `${zh ? "仓库绑定" : "Repository"} · ${boundRepository?.displayName ?? repositoryId}`
              : zh ? "仓库绑定 · 未绑定" : "Repository · not bound"}
          </span>
        </div>
        <div className="ds-section-actions" role="group" aria-label={zh ? "当前门禁动作" : "Current gate actions"}>
          {nextGate === "validate" && (
            <Button type="button" size="sm" variant="primary" onClick={openDefinitionDialog}>
              <CheckCircle2 size={13} />
              {zh ? "校验" : "Validate"}
            </Button>
          )}
          {nextGate === "save" && (
            <Button type="button" size="sm" variant="primary" onClick={openDefinitionDialog}>
              <Save size={13} />
              {zh ? "保存 revision" : "Save revision"}
            </Button>
          )}
          {nextGate === "dry" && (
            <Button type="button" size="sm" variant="primary" onClick={() => void runDryLoad()}>
              <ShieldCheck size={13} />
              {zh ? "Dry-load" : "Dry-load"}
            </Button>
          )}
          {nextGate === "repo" && (
            <Button type="button" size="sm" variant="primary" onClick={openExecutionDialog}>
              <SlidersHorizontal size={13} />
              {zh ? "配置执行" : "Configure execution"}
            </Button>
          )}
          {nextGate === "run" && (
            <Button type="button" size="sm" variant="primary" onClick={openExecutionDialog}>
              <PlayCircle size={13} />
              {zh ? "运行" : "Run"}
            </Button>
          )}
          {isLaterGate("save") && (
            <Button type="button" size="sm" variant="secondary" disabled>
              <Save size={13} />
              {zh ? "保存 revision" : "Save revision"}
            </Button>
          )}
          {isLaterGate("dry") && (
            <Button type="button" size="sm" variant="secondary" disabled>
              <ShieldCheck size={13} />
              {zh ? "Dry-load" : "Dry-load"}
            </Button>
          )}
          {isLaterGate("run") && (
            <Button type="button" size="sm" variant="secondary" disabled>
              <PlayCircle size={13} />
              {zh ? "运行" : "Run"}
            </Button>
          )}
        </div>
        <p className="muted-note">{nextActionText}</p>
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
        {saveError && <div className="route-query-notice" role="alert"><span>{saveError}</span></div>}
      </section>

      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker">{zh ? "历史" : "History"}</span>
            <h2 className="ds-section-title">{zh ? "Run 历史（持久化）" : "Run history (persisted)"}</h2>
          </div>
          <div className="ds-section-actions">
            <Button type="button" size="sm" variant="secondary" onClick={() => void loadRuns()}>
              <RotateCcw size={13} />
              {zh ? "刷新" : "Refresh"}
            </Button>
          </div>
        </div>
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
        {runs.length === 0 ? (
          <div className="ds-empty ds-empty--slim">
            <span className="ds-empty-icon"><Inbox size={20} /></span>
            <p className="ds-empty-text">{zh ? "暂无 run 历史（空 ≠ 不可用）。" : "No run history yet (empty, not unavailable)."}</p>
          </div>
        ) : (
          <div className="ds-row-list" role="list">
            {runs.map(summary => (
              <article className="ds-row" role="listitem" key={summary.runId}>
                <span className={summary.status === "succeeded" ? "ds-chip ds-chip--ok" : "ds-chip ds-chip--muted"}>
                  <i />{summary.status}
                </span>
                <div className="ds-row-main">
                  <strong className="ds-row-title ds-row-sub--mono">{summary.definitionId}</strong>
                  <small className="ds-row-sub ds-row-sub--mono">
                    {summary.revisionId.slice(0, 14)}… · {summary.repository}
                    {summary.trigger ? ` · ${summary.trigger.source === "repository_change" ? (zh ? "变更触发" : "change") : zh ? "手动" : "manual"}` : ""}
                  </small>
                </div>
                <span className="ds-row-meta">{summary.evidenceCount} ev · {summary.findingCount} {zh ? "发现" : "findings"}</span>
                <span className="ds-row-meta">{new Date(summary.createdAt).toLocaleString()}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <WorkflowDefinitionDialog
        isOpen={definitionDialogOpen}
        onClose={() => setDefinitionDialogOpen(false)}
        zh={zh}
        definitions={definitions}
        definitionsUnavailable={definitionsUnavailable}
        selectedDefinitionId={selectedDefinitionId}
        onDefinitionChange={setSelectedDefinitionId}
        selectedRevision={selectedRevision}
        definitionText={definitionText}
        onDefinitionTextChange={setDefinitionText}
        validating={validating}
        validation={validation}
        onValidate={() => void validateDefinition()}
        isBuiltinSelected={isBuiltinSelected}
        onSaveRevision={() => void saveRevision()}
        saveNotice={saveNotice}
        saveError={saveError}
      />
      <WorkflowExecutionDialog
        isOpen={executionDialogOpen}
        onClose={() => setExecutionDialogOpen(false)}
        zh={zh}
        repositories={repositories}
        repositoriesUnavailable={repositoriesUnavailable}
        repositoryId={repositoryId}
        onRepositoryChange={setRepositoryId}
        selectedRevision={selectedRevision}
        selectedDefinitionId={selectedDefinitionId}
        triggering={triggering}
        onRun={() => void triggerRun()}
        runError={runError}
      />
    </div>
  );
}
export function WorkflowPage({
  automations = [],
  repositories = [],
  jobs = [],
  capabilities,
  actionError,
  changingAutomationId,
  onSetEnabled
}: {
  automations?: Automation[];
  repositories?: Repository[];
  jobs?: ReviewJob[];
  capabilities?: AuditCapabilities;
  actionError?: string;
  changingAutomationId?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
} = {}) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const [searchParams, setSearchParams] = useSearchParams();
  const [wizardOpen, setWizardOpen] = useState(false);
  // Workflow family IA: Runtime Studio is the primary surface and the default
  // when no ?tab= is present. The legacy definition builder was removed; its
  // ?tab=definition deep link redirects to the Studio tab instead of rendering
  // a deleted surface (replace-history so Back returns to wherever the user
  // came from, not the dead link).
  const requestedTab = searchParams.get("tab");
  useEffect(() => {
    if (requestedTab === "definition") setSearchParams({ tab: "studio" }, { replace: true });
  }, [requestedTab, setSearchParams]);
  const activeTab =
    requestedTab === "triggers" ? "triggers"
      : requestedTab === "runtime" ? "runtime"
        : requestedTab === "xray" ? "xray"
          : "studio";
  const workflowTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const keepActiveWorkflowTabVisible = useCallback(() => {
    const tab = workflowTabRefs.current.get(activeTab);
    if (!tab || typeof tab.scrollIntoView !== "function") {
      if (tab) adjustWorkflowTabRail(tab);
      return;
    }
    try {
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // Older DOM implementations may expose scrollIntoView without options.
      adjustWorkflowTabRail(tab);
    }
  }, [activeTab, locale]);
  const registerWorkflowTab = useCallback((tab: string, element: HTMLButtonElement | null) => {
    if (element) workflowTabRefs.current.set(tab, element);
    else workflowTabRefs.current.delete(tab);
  }, []);
  useEffect(() => {
    keepActiveWorkflowTabVisible();
    const handleResize = () => keepActiveWorkflowTabVisible();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [keepActiveWorkflowTabVisible]);

  return <div className="page-stack workflows-page">
    <div className="workflow-sub-nav" role="tablist" aria-label={t("Workflow views")}>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "studio"}
        className={`workflow-tab ${activeTab === "studio" ? "active" : ""}`}
        ref={element => registerWorkflowTab("studio", element)}
        onClick={() => setSearchParams({ tab: "studio" })}
      >
        <GitBranch size={14} />
        {zh ? "Runtime Studio" : "Runtime Studio"}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "runtime"}
        className={`workflow-tab ${activeTab === "runtime" ? "active" : ""}`}
        ref={element => registerWorkflowTab("runtime", element)}
        onClick={() => setSearchParams({ tab: "runtime" })}
      >
        <ShieldCheck size={14} />
        {zh ? "已验证运行时" : "Verified runtime"}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "triggers"}
        className={`workflow-tab ${activeTab === "triggers" ? "active" : ""}`}
        ref={element => registerWorkflowTab("triggers", element)}
        onClick={() => setSearchParams({ tab: "triggers" })}
      >
        <CalendarClock size={14} />
        {zh ? "触发器与策略" : "Triggers"}
        {automations.length > 0 && <span className="tab-count">({automations.length})</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "xray"}
        className={`workflow-tab ${activeTab === "xray" ? "active" : ""}`}
        ref={element => registerWorkflowTab("xray", element)}
        onClick={() => setSearchParams({ tab: "xray" })}
      >
        <SearchCode size={14} />
        {t("Pipeline Inspector")}
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
      <>
        <WorkflowRuntimeView zh={zh} />
        <div className="ds-section">
          <Button type="button" size="sm" variant="secondary" onClick={() => setWizardOpen(true)}>
            <PlayCircle size={13} />
            {t("Start the review wizard")}
          </Button>
        </div>
      </>
    ) : activeTab === "xray" ? (
      <WorkflowXRayView jobs={jobs} />
    ) : (
      <RuntimeStudio />
    )}
    {wizardOpen && (
      <ReviewWizardDialog
        repositories={repositories}
        onClose={() => setWizardOpen(false)}
      />
    )}
  </div>;
}
