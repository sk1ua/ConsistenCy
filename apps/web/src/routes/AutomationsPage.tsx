import { Link } from "react-router-dom";
import type { AuditCapabilities, Automation, Repository } from "@consistency/schema";
import { CalendarClock, CheckCircle2, GitPullRequest, PauseCircle, PlayCircle, Radio, ShieldCheck, Workflow } from "lucide-react";
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

  return (
    <div className="automation-route page-stack">
      {/* 1. Clean Header */}
      <section className="section-block automation-header-strip">
        <div className="automation-title-wrap">
          <CalendarClock size={20} className="automation-icon-main" />
          <div>
            <h2>{zh ? "自动化策略" : "Automations"}</h2>
            <p>{zh ? "按代码提交、拉取请求或定时计划自动触发 ConsistenCy 审查。" : "Automatically trigger ConsistenCy reviews on push, PR, or schedule."}</p>
          </div>
        </div>
        <Link to="/workflows" className="primary-button btn-small">
          <Workflow size={13} /> {zh ? "工作流定义" : "Workflows"}
        </Link>
      </section>

      {unavailable && (
        <div className="route-query-notice" role="alert">
          <strong>{zh ? "自动化定义暂不可用" : "Automation definitions are unavailable"}</strong>
          <span>{zh ? "已缓存的其他审计数据仍可继续使用。" : "Other cached audit data remains available."}</span>
        </div>
      )}

      {actionError && (
        <div className="route-query-notice" role="alert">
          <strong>{zh ? "无法更新自动化" : "Could not update automation"}</strong>
          <span>{actionError}</span>
        </div>
      )}

      {/* 2. List or Compact Empty State */}
      {automations.length > 0 ? (
        <section className="section-block automation-registry">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "策略列表" : "Policy List"}</span>
              <h2>{zh ? "已持久化自动化" : "Persisted Automations"}</h2>
            </div>
            <span className={capabilities?.automationScheduling ? "capability-state ready" : "capability-state pending"}>
              {capabilities?.automationScheduling ? (zh ? "调度就绪" : "Scheduler ready") : (zh ? "仅保存定义" : "Definitions only")}
            </span>
          </div>

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
        </section>
      ) : (
        <section className="section-block automation-compact-empty">
          <div className="compact-empty-head">
            <CalendarClock size={20} className="empty-icon" />
            <div>
              <h3>{zh ? "暂无自动化策略" : "No Automations Configured"}</h3>
              <p>{zh ? "自动化可以按 Webhook 事件或工作流计划自动执行审查。" : "Automations run review workflows automatically on webhook events."}</p>
            </div>
          </div>

          <div className="automation-triggers-summary">
            <div className="trigger-status-item">
              <CheckCircle2 size={14} className="icon-success" />
              <span>{zh ? "GitHub Webhook 触发" : "GitHub Webhooks"}</span>
            </div>
            <div className="trigger-status-item">
              <CheckCircle2 size={14} className="icon-success" />
              <span>{zh ? "手动与公开 PR 审查" : "Manual & Public PR Reviews"}</span>
            </div>
            <div className="trigger-status-item muted">
              <Radio size={14} />
              <span>{zh ? "定时计划（后续里程碑）" : "Scheduled Cron (Roadmap)"}</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
