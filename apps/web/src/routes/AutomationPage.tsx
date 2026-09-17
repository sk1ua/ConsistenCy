import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarClock,
  GitBranch,
  PauseCircle,
  PlayCircle,
  Plus,
  Workflow,
  Zap
} from "lucide-react";
import {
  createAutomationRequestSchema,
  type Automation,
  type CreateAutomationRequest,
  type Repository
} from "@consistency/schema";
import { api } from "../api/client";
import { Badge } from "../design-system/Badge";
import { Button, ButtonLink } from "../design-system/Button";
import { useI18n } from "../i18n";
import { workspaceQueryKeys } from "../query/client";
import { safeRequestError } from "../query/safeRequestError";

export interface AutomationPageProps {
  automations?: Automation[];
  repositories?: Repository[];
  capabilities?: { automationScheduling?: boolean; automationDefinitions?: boolean };
  changingAutomationId?: string;
  actionError?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
}

function triggerLabel(automation: Automation, zh: boolean): string {
  if (automation.trigger.type === "manual") return zh ? "手动" : "Manual";
  if (automation.trigger.type === "schedule") {
    return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  }
  return automation.trigger.eventTypes.join(" · ");
}

/**
 * Mature Automation surface: manage real saved triggers, deep-link Studio,
 * document cron as upcoming, and offer minimal create for manual /
 * repository_event when policy + workflow revisions exist.
 */
export function AutomationPage({
  automations = [],
  repositories = [],
  capabilities,
  changingAutomationId,
  actionError,
  onSetEnabled
}: AutomationPageProps) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const queryClient = useQueryClient();
  const enabledCount = automations.filter(a => a.enabled).length;
  const [showCreate, setShowCreate] = useState(false);

  const policiesQuery = useQuery({
    queryKey: ["workspace", "policy-revisions"],
    queryFn: () => api.policyRevisions(),
    enabled: showCreate
  });
  const workflowsQuery = useQuery({
    queryKey: ["workspace", "workflow-revisions"],
    queryFn: () => api.workflowRevisions(),
    enabled: showCreate
  });
  const runtimeDefsQuery = useQuery({
    queryKey: workspaceQueryKeys.workflowRuntimeDefinitions,
    queryFn: () => api.workflowRuntimeDefinitions(),
    enabled: showCreate
  });

  const [form, setForm] = useState({
    name: "",
    repositoryId: "",
    triggerType: "repository_event" as "manual" | "repository_event",
    eventType: "pull_request" as "working_tree" | "pull_request" | "commit_pushed",
    policyRevisionId: "",
    workflowRevisionId: "",
    runtimeDefinitionId: ""
  });

  React.useEffect(() => {
    if (!showCreate) return;
    if (!form.repositoryId && repositories[0]) {
      setForm(f => ({ ...f, repositoryId: repositories[0]!.id }));
    }
    const policies = policiesQuery.data ?? [];
    if (!form.policyRevisionId && policies[0]) {
      setForm(f => ({ ...f, policyRevisionId: policies[0]!.id }));
    }
    const workflows = workflowsQuery.data ?? [];
    if (!form.workflowRevisionId && !form.runtimeDefinitionId && workflows[0]) {
      setForm(f => ({ ...f, workflowRevisionId: workflows[0]!.id }));
    }
    const runtime = runtimeDefsQuery.data ?? [];
    if (!form.workflowRevisionId && !form.runtimeDefinitionId && runtime[0]) {
      setForm(f => ({ ...f, runtimeDefinitionId: runtime[0]!.definitionId }));
    }
  }, [
    showCreate,
    repositories,
    policiesQuery.data,
    workflowsQuery.data,
    runtimeDefsQuery.data,
    form.repositoryId,
    form.policyRevisionId,
    form.workflowRevisionId,
    form.runtimeDefinitionId
  ]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const trigger =
        form.triggerType === "manual"
          ? { type: "manual" as const }
          : {
              type: "repository_event" as const,
              eventTypes: [form.eventType],
              debounceMs: 5_000
            };
      const body: CreateAutomationRequest = createAutomationRequestSchema.parse({
        repositoryId: form.repositoryId,
        name: form.name.trim() || (zh ? "新触发策略" : "New trigger"),
        trigger,
        policyRevisionId: form.policyRevisionId,
        executionProfile: "static_readonly",
        enabled: true,
        ...(form.workflowRevisionId ? { workflowRevisionId: form.workflowRevisionId } : {}),
        ...(form.runtimeDefinitionId ? { runtimeDefinitionId: form.runtimeDefinitionId } : {})
      });
      return api.createAutomation(body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.automations });
      setShowCreate(false);
      setForm(f => ({ ...f, name: "" }));
    }
  });

  const canCreate = useMemo(() => {
    const hasPolicy = Boolean(form.policyRevisionId);
    const hasWorkflow = Boolean(form.workflowRevisionId || form.runtimeDefinitionId);
    return Boolean(form.repositoryId && hasPolicy && hasWorkflow);
  }, [form]);

  const schedulingReady = capabilities?.automationScheduling === true;

  return (
    <div className="ds-page coming-soon-page coming-soon-page--product automation-page" data-testid="automation-page">
      <div className="coming-soon-page__back">
        <ButtonLink to="/inbox" variant="ghost" size="sm" icon={<ArrowLeft size={13} />}>
          {zh ? "返回审查工作台" : "Back to review workbench"}
        </ButtonLink>
      </div>

      <header className="coming-soon-hero">
        <div className="coming-soon-hero__icon" aria-hidden="true">
          <Zap size={22} />
        </div>
        <div className="coming-soon-hero__copy">
          <div className="coming-soon-hero__kicker">
            <Badge variant="neutral" size="sm">{zh ? "触发策略" : "Triggers"}</Badge>
            <span className="coming-soon-hero__meta">
              {zh
                ? `${automations.length} 条定义 · ${enabledCount} 已启用`
                : `${automations.length} definition${automations.length === 1 ? "" : "s"} · ${enabledCount} enabled`}
            </span>
            <span className={schedulingReady ? "ds-chip ds-chip--ok" : "ds-chip ds-chip--muted"}>
              {schedulingReady ? (zh ? "调度就绪" : "Scheduler ready") : (zh ? "Cron 即将接入" : "Cron upcoming")}
            </span>
          </div>
          <h1 className="coming-soon-hero__title">{zh ? "自动化" : "Automation"}</h1>
          <p className="coming-soon-hero__desc">
            {zh
              ? "管理已保存的仓库事件 / 手动触发策略，与工作流 Studio、审查运行共用证据链路。定时 cron 调度仍在接入中，不会在此伪造运行中的计划。"
              : "Manage saved repository-event and manual triggers — same evidence path as Workflow Studio and review runs. Cron scheduling is still landing; we will not invent running schedules here."}
          </p>
        </div>
      </header>

      <section className="coming-soon-grid" aria-label={zh ? "入口" : "Entry points"}>
        <article className="coming-soon-card">
          <header>
            <Workflow size={16} />
            <h2>{zh ? "工作流 Studio · 触发器" : "Studio · Triggers"}</h2>
          </header>
          <p>
            {zh
              ? "完整的触发器列表、启停与运行时绑定仍在 Studio 的「触发器」页。"
              : "Full trigger list, pause/resume, and runtime bindings live under Studio → Triggers."}
          </p>
          <ButtonLink to="/workflows?tab=triggers" variant="outline" size="sm">
            {zh ? "打开触发器" : "Open triggers"}
          </ButtonLink>
        </article>
        <article className="coming-soon-card">
          <header>
            <CalendarClock size={16} />
            <h2>{zh ? "Cron 调度" : "Cron schedules"}</h2>
          </header>
          <p>
            {zh
              ? "Webhook / 手动 / 仓库事件已可用。五字段 cron + 时区属于后续里程碑；定义可保存，但此处不假装调度器已在跑。"
              : "Webhooks, manual, and repository events work today. Five-field cron + timezone is a later milestone — definitions may exist, but we will not pretend a scheduler is firing."}
          </p>
          <ButtonLink to="/workflows" variant="outline" size="sm">
            {zh ? "打开工作流 Studio" : "Open Workflow Studio"}
          </ButtonLink>
        </article>
        <article className="coming-soon-card">
          <header>
            <GitBranch size={16} />
            <h2>{zh ? "服务审查工作台" : "Serves the workbench"}</h2>
          </header>
          <p>
            {zh
              ? "自动化产出的仍是证据审查运行：结果回到中间工作台与右侧相关卡片。"
              : "Automations still produce evidence-review runs — results land in the workbench and related cards."}
          </p>
          <ButtonLink to="/inbox" variant="outline" size="sm">
            {zh ? "返回工作台" : "Return to workbench"}
          </ButtonLink>
        </article>
      </section>

      <section className="automation-live" aria-label={zh ? "已保存触发定义" : "Saved trigger definitions"}>
        <div className="automation-live__head">
          <div>
            <h2>{zh ? "已保存的触发定义" : "Saved trigger definitions"}</h2>
            <p>
              {zh
                ? "来自审计域的真实数据。可在此启停；创建支持手动与仓库事件（需已有策略与工作流修订）。"
                : "Real audit-domain data. Pause/resume here; create supports manual and repository events when policy + workflow revisions exist."}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            onClick={() => setShowCreate(v => !v)}
          >
            {showCreate ? (zh ? "收起创建" : "Hide create") : (zh ? "新建触发" : "New trigger")}
          </Button>
        </div>

        {actionError ? (
          <div className="route-query-notice" role="alert">
            <strong>{zh ? "无法更新自动化策略" : "Could not update automation policy"}</strong>
            <span>{actionError}</span>
          </div>
        ) : null}

        {showCreate ? (
          <form
            className="automation-create"
            data-testid="automation-create-form"
            onSubmit={event => {
              event.preventDefault();
              if (canCreate && !createMutation.isPending) createMutation.mutate();
            }}
          >
            <label>
              <span>{zh ? "名称" : "Name"}</span>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={zh ? "例如：PR 安全门禁" : "e.g. PR safety gate"}
              />
            </label>
            <label>
              <span>{zh ? "仓库" : "Repository"}</span>
              <select
                value={form.repositoryId}
                onChange={e => setForm(f => ({ ...f, repositoryId: e.target.value }))}
              >
                {repositories.length === 0 ? <option value="">{zh ? "无已注册仓库" : "No repositories"}</option> : null}
                {repositories.map(repo => (
                  <option key={repo.id} value={repo.id}>{repo.displayName}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{zh ? "触发类型" : "Trigger"}</span>
              <select
                value={form.triggerType}
                onChange={e => setForm(f => ({
                  ...f,
                  triggerType: e.target.value as "manual" | "repository_event"
                }))}
              >
                <option value="repository_event">{zh ? "仓库事件" : "Repository event"}</option>
                <option value="manual">{zh ? "手动" : "Manual"}</option>
              </select>
            </label>
            {form.triggerType === "repository_event" ? (
              <label>
                <span>{zh ? "事件" : "Event"}</span>
                <select
                  value={form.eventType}
                  onChange={e => setForm(f => ({
                    ...f,
                    eventType: e.target.value as typeof form.eventType
                  }))}
                >
                  <option value="pull_request">pull_request</option>
                  <option value="working_tree">working_tree</option>
                  <option value="commit_pushed">commit_pushed</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>{zh ? "策略修订" : "Policy revision"}</span>
              <select
                value={form.policyRevisionId}
                onChange={e => setForm(f => ({ ...f, policyRevisionId: e.target.value }))}
              >
                {(policiesQuery.data ?? []).length === 0 ? (
                  <option value="">{zh ? "暂无策略修订" : "No policy revisions"}</option>
                ) : null}
                {(policiesQuery.data ?? []).map(policy => (
                  <option key={policy.id} value={policy.id}>{policy.name} · {policy.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{zh ? "工作流修订" : "Workflow revision"}</span>
              <select
                value={form.workflowRevisionId}
                onChange={e => setForm(f => ({
                  ...f,
                  workflowRevisionId: e.target.value,
                  runtimeDefinitionId: e.target.value ? "" : f.runtimeDefinitionId
                }))}
              >
                <option value="">{zh ? "（可选）" : "(optional)"}</option>
                {(workflowsQuery.data ?? []).map(wf => (
                  <option key={wf.id} value={wf.id}>{wf.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{zh ? "运行时定义" : "Runtime definition"}</span>
              <select
                value={form.runtimeDefinitionId}
                onChange={e => setForm(f => ({
                  ...f,
                  runtimeDefinitionId: e.target.value,
                  workflowRevisionId: e.target.value ? "" : f.workflowRevisionId
                }))}
              >
                <option value="">{zh ? "（可选）" : "(optional)"}</option>
                {(runtimeDefsQuery.data ?? []).map(def => (
                  <option key={def.definitionId} value={def.definitionId}>{def.definitionId}</option>
                ))}
              </select>
            </label>
            <div className="automation-create__actions">
              <Button type="submit" size="sm" variant="primary" disabled={!canCreate || createMutation.isPending}>
                {createMutation.isPending ? (zh ? "创建中…" : "Creating…") : (zh ? "创建" : "Create")}
              </Button>
              {!canCreate ? (
                <span className="automation-create__hint">
                  {zh
                    ? "需要仓库 + 策略修订 +（工作流修订或运行时定义）。可先在 Studio 保存修订。"
                    : "Needs repository + policy revision + (workflow revision or runtime definition). Save revisions in Studio first."}
                </span>
              ) : null}
              {createMutation.isError ? (
                <span className="automation-create__error" role="alert">
                  {safeRequestError(createMutation.error)}
                </span>
              ) : null}
            </div>
            <p className="automation-create__note">
              {zh
                ? "不支持在此创建 cron 调度触发（即将接入）。"
                : "Cron schedule triggers cannot be created here yet (upcoming)."}
            </p>
          </form>
        ) : null}

        {automations.length > 0 ? (
          <ul className="automation-live__list">
            {automations.map(automation => {
              const repository = repositories.find(r => r.id === automation.repositoryId);
              const isSchedule = automation.trigger.type === "schedule";
              return (
                <li key={automation.id}>
                  <span
                    className="related-dot"
                    style={{ background: automation.enabled ? "var(--success)" : "var(--muted)" }}
                  />
                  <div className="automation-live__main">
                    <strong>{automation.name}</strong>
                    <span className="coming-soon-live__meta">
                      {repository?.displayName ?? automation.repositoryId}
                      {" · "}
                      {triggerLabel(automation, zh)}
                      {isSchedule ? (zh ? " · cron 定义已保存（调度即将接入）" : " · cron saved (scheduler upcoming)") : ""}
                    </span>
                  </div>
                  <Badge variant="neutral" size="sm">
                    {automation.enabled ? (zh ? "已启用" : "enabled") : (zh ? "已暂停" : "paused")}
                  </Badge>
                  {onSetEnabled ? (
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
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="repo-directory-preview__stub">
            {zh
              ? "暂无触发定义。可在上方新建（需策略/工作流修订），或到 Studio 触发器页管理。"
              : "No trigger definitions yet. Create above when policy/workflow revisions exist, or manage in Studio → Triggers."}
          </p>
        )}
      </section>
    </div>
  );
}

