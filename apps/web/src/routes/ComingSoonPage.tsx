import React from "react";
import {
  ArrowLeft,
  CalendarClock,
  GitBranch,
  Puzzle,
  ShieldCheck,
  Workflow,
  Zap
} from "lucide-react";
import type { Automation } from "@consistency/schema";
import { Badge } from "../design-system/Badge";
import { ButtonLink } from "../design-system/Button";
import { useI18n } from "../i18n";

export type ComingSoonKind = "automation" | "plugins";

export interface ComingSoonPageProps {
  kind: ComingSoonKind;
  /** Light wiring: real automation definitions when available (no fake schedules). */
  automations?: Automation[];
}

/**
 * Product-style entry surfaces for Automation / Plugins.
 * Still "即将接入" for unfinished product areas — but explain intent, relate to
 * workflows/reviews, and offer a clear path back to the workbench.
 */
export function ComingSoonPage({ kind, automations = [] }: ComingSoonPageProps) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const isAutomation = kind === "automation";
  const enabledCount = automations.filter(a => a.enabled).length;

  return (
    <div className="ds-page coming-soon-page coming-soon-page--product">
      <div className="coming-soon-page__back">
        <ButtonLink to="/inbox" variant="ghost" size="sm" icon={<ArrowLeft size={13} />}>
          {zh ? "返回审查工作台" : "Back to review workbench"}
        </ButtonLink>
      </div>

      <header className="coming-soon-hero">
        <div className="coming-soon-hero__icon" aria-hidden="true">
          {isAutomation ? <Zap size={22} /> : <Puzzle size={22} />}
        </div>
        <div className="coming-soon-hero__copy">
          <div className="coming-soon-hero__kicker">
            <Badge variant="neutral" size="sm">{zh ? "即将接入" : "Coming soon"}</Badge>
            {isAutomation && automations.length > 0 ? (
              <span className="coming-soon-hero__meta">
                {zh
                  ? `${automations.length} 条触发定义 · ${enabledCount} 已启用`
                  : `${automations.length} trigger definition${automations.length === 1 ? "" : "s"} · ${enabledCount} enabled`}
              </span>
            ) : null}
          </div>
          <h1 className="coming-soon-hero__title">
            {isAutomation
              ? (zh ? "自动化" : "Automation")
              : (zh ? "插件市场" : "Plugins")}
          </h1>
          <p className="coming-soon-hero__desc">
            {isAutomation
              ? (zh
                ? "把审查接到仓库事件与策略触发上：与工作流 Studio、审查运行共用同一证据链路。调度与市场级编排仍在接入中。"
                : "Connect reviews to repository events and policy triggers — same evidence path as Workflow Studio and review runs. Scheduling and market-style orchestration are still landing.")
              : (zh
                ? "扩展分析器、校验器与 UI 贡献点。入口已预留；暂不展示虚假插件列表或商店。"
                : "Extension points for analyzers, verifiers, and UI contributions. Entry reserved — no fake marketplace listings.")}
          </p>
        </div>
      </header>

      <section className="coming-soon-grid" aria-label={zh ? "能力预览" : "Capability preview"}>
        {isAutomation ? (
          <>
            <article className="coming-soon-card">
              <header>
                <Workflow size={16} />
                <h2>{zh ? "与工作流联动" : "Tied to workflows"}</h2>
              </header>
              <p>
                {zh
                  ? "触发策略绑定到已验证工作流修订；今天可在工作流 Studio 的「触发器」页查看与启停已保存定义。"
                  : "Trigger policies bind to validated workflow revisions. Today you can view and pause saved definitions under Workflow Studio → Triggers."}
              </p>
              <ButtonLink to="/workflows?tab=triggers" variant="outline" size="sm">
                {zh ? "打开触发器" : "Open triggers"}
              </ButtonLink>
            </article>
            <article className="coming-soon-card">
              <header>
                <CalendarClock size={16} />
                <h2>{zh ? "事件与计划" : "Events & schedules"}</h2>
              </header>
              <p>
                {zh
                  ? "Webhook / 手动审查已可用；定时 cron 调度属于后续里程碑，不会在此伪造运行中的计划。"
                  : "Webhooks and manual review are available; cron scheduling is a later milestone — we will not invent running schedules here."}
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
                  ? "自动化产出的仍是证据审查运行：结果回到中间工作台与右侧相关卡片，而不是独立聊天会话。"
                  : "Automations still produce evidence-review runs — results land in the center workbench and related cards, not a separate chat thread."}
              </p>
              <ButtonLink to="/inbox" variant="outline" size="sm">
                {zh ? "返回工作台" : "Return to workbench"}
              </ButtonLink>
            </article>
          </>
        ) : (
          <>
            <article className="coming-soon-card">
              <header>
                <ShieldCheck size={16} />
                <h2>{zh ? "能力与安全边界" : "Capabilities & safety"}</h2>
              </header>
              <p>
                {zh
                  ? "插件走 Kernel 能力与沙箱边界；未就绪前不会假装已有可安装商店条目。"
                  : "Plugins go through Kernel capabilities and sandbox boundaries. Until ready, we will not pretend installable store entries exist."}
              </p>
            </article>
            <article className="coming-soon-card">
              <header>
                <Workflow size={16} />
                <h2>{zh ? "贡献审查链路" : "Contribute to review"}</h2>
              </header>
              <p>
                {zh
                  ? "目标是扩展确定性分析与校验节点，接入现有工作流运行时，而不是平行的第三方应用墙。"
                  : "Goal: extend deterministic analyzers and verifier nodes into the existing workflow runtime — not a parallel app wall."}
              </p>
              <ButtonLink to="/workflows" variant="outline" size="sm">
                {zh ? "查看工作流运行时" : "View workflow runtime"}
              </ButtonLink>
            </article>
            <article className="coming-soon-card">
              <header>
                <Puzzle size={16} />
                <h2>{zh ? "回到工作台" : "Back to workbench"}</h2>
              </header>
              <p>
                {zh
                  ? "日常审查仍从左侧仓库与「开始审查」进入；插件入口不会抢走主路径。"
                  : "Day-to-day review still starts from the left repo list and Start Review; this entry will not steal the primary path."}
              </p>
              <ButtonLink to="/inbox" variant="outline" size="sm">
                {zh ? "返回工作台" : "Return to workbench"}
              </ButtonLink>
            </article>
          </>
        )}
      </section>

      {isAutomation && automations.length > 0 ? (
        <section className="coming-soon-live" aria-label={zh ? "已保存触发定义" : "Saved trigger definitions"}>
          <div className="coming-soon-live__head">
            <h2>{zh ? "已保存的触发定义" : "Saved trigger definitions"}</h2>
            <p>
              {zh
                ? "来自工作流运行时的真实数据（只读预览）。启停请到触发器页操作。"
                : "Real data from the workflow runtime (read-only preview). Enable/pause on the Triggers page."}
            </p>
          </div>
          <ul className="coming-soon-live__list">
            {automations.slice(0, 5).map(automation => (
              <li key={automation.id}>
                <span className={`related-dot`} style={{ background: automation.enabled ? "var(--success)" : "var(--muted)" }} />
                <strong>{automation.name}</strong>
                <span className="coming-soon-live__meta mono">{automation.repositoryId}</span>
                <Badge variant="neutral" size="sm">
                  {automation.enabled ? (zh ? "已启用" : "enabled") : (zh ? "已暂停" : "paused")}
                </Badge>
              </li>
            ))}
          </ul>
          <ButtonLink to="/workflows?tab=triggers" variant="primary" size="sm">
            {zh ? "在触发器中管理" : "Manage in Triggers"}
          </ButtonLink>
        </section>
      ) : null}
    </div>
  );
}
