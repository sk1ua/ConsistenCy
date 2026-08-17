import { Link } from "react-router-dom";
import type { AuditCapabilities, Automation, Repository } from "@consistency/schema";
import { CalendarClock, GitPullRequest, PauseCircle, PlayCircle, Radio, ShieldCheck, Workflow } from "lucide-react";
import { useI18n } from "../i18n";

function triggerLabel(automation: Automation, zh: boolean): string {
  if (automation.trigger.type === "manual") return zh ? "手动" : "Manual";
  if (automation.trigger.type === "schedule") return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  return automation.trigger.eventTypes.join(" · ");
}

export function AutomationsPage({
  automations = [],
  repositories = [],
  capabilities,
  unavailable = false,
  actionError,
  changingAutomationId,
  onSetEnabled
}: {
  automations?: Automation[];
  repositories?: Repository[];
  capabilities?: AuditCapabilities;
  unavailable?: boolean;
  actionError?: string;
  changingAutomationId?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  return <div className="automation-route page-stack">
    {unavailable && <div className="route-query-notice" role="alert"><strong>{zh ? "自动化定义暂不可用" : "Automation definitions are unavailable"}</strong><span>{zh ? "已缓存的其他审计数据仍可继续使用。" : "Other cached audit data remains available."}</span></div>}
    {actionError && <div className="route-query-notice" role="alert"><strong>{zh ? "无法更新自动化" : "Could not update automation"}</strong><span>{actionError}</span></div>}
    {automations.length > 0 && <section className="section-block automation-registry">
      <div className="panel-title"><div><span className="panel-kicker">{zh ? "项目级历史" : "Repository policy"}</span><h2>{zh ? "已持久化自动化" : "Persisted automations"}</h2></div><span className={capabilities?.automationScheduling ? "capability-state ready" : "capability-state pending"}>{capabilities?.automationScheduling ? (zh ? "调度已启用" : "Scheduler ready") : (zh ? "仅保存定义" : "Definitions only")}</span></div>
      <div className="automation-list" role="list">{automations.map(automation => {
        const repository = repositories.find(candidate => candidate.id === automation.repositoryId);
        return <article className="automation-row" role="listitem" key={automation.id}>
          <span className={automation.enabled ? "automation-state enabled" : "automation-state"}><i />{automation.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已暂停" : "Paused")}</span>
          <div><strong>{automation.name}</strong><small>{repository?.displayName ?? automation.repositoryId}</small></div>
          <span><CalendarClock size={14} />{triggerLabel(automation, zh)}</span>
          <span><ShieldCheck size={14} />{automation.executionProfile === "static_readonly" ? (zh ? "静态只读" : "Static read-only") : (zh ? "受信沙箱" : "Trusted sandbox")}</span>
          {onSetEnabled && <button type="button" disabled={changingAutomationId === automation.id} onClick={() => onSetEnabled(automation, !automation.enabled)}>{automation.enabled ? <PauseCircle size={15} /> : <PlayCircle size={15} />}{automation.enabled ? (zh ? "暂停" : "Pause") : (zh ? "恢复" : "Resume")}</button>}
        </article>;
      })}</div>
    </section>}
    {automations.length === 0 && <section className="automation-empty section-block">
      <div className="automation-empty-mark"><CalendarClock size={24} /></div>
      <span className="panel-kicker">{zh ? "能力边界" : "Capability boundary"}</span>
      <h2>{capabilities?.automationDefinitions ? (zh ? "还没有自动化定义。" : "No automation definitions yet.") : (zh ? "自动化调度尚未由当前 API 提供。" : "Automation scheduling is not available in the current API yet.")}</h2>
      <p>{zh ? "这里不会伪造计划任务。现有 GitHub webhook、手动公开 PR 分析和确定性工作流仍可照常使用。" : "This workspace does not invent scheduled tasks. Existing GitHub webhooks, manual public PR analysis, and deterministic workflows remain available."}</p>
      <div className="automation-capabilities" role="list">
        <span role="listitem"><GitPullRequest size={16} /><strong>{zh ? "当前可用" : "Available now"}</strong><small>{zh ? "公开 PR 与 GitHub App 触发" : "Public PR and GitHub App triggers"}</small></span>
        <span role="listitem"><Workflow size={16} /><strong>{zh ? "当前可用" : "Available now"}</strong><small>{zh ? "可审计的确定性分析 DAG" : "Auditable deterministic analysis DAGs"}</small></span>
        <span role="listitem" className="pending"><Radio size={16} /><strong>{zh ? "后续里程碑" : "Later milestone"}</strong><small>{zh ? "Cron、本地变更触发与运行策略" : "Cron, local-change triggers, and run policy"}</small></span>
      </div>
      <Link className="primary-button" to="/workflows">{zh ? "打开工作流构建器" : "Open workflow builder"}<Workflow size={15} /></Link>
    </section>}
  </div>;
}
