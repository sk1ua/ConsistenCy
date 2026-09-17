import React from "react";
import { ArrowLeft, Puzzle, Zap } from "lucide-react";
import { EmptyState } from "../design-system/EmptyState";
import { ButtonLink } from "../design-system/Button";
import { useI18n } from "../i18n";

export type ComingSoonKind = "automation" | "plugins";

export function ComingSoonPage({ kind }: { kind: ComingSoonKind }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const isAutomation = kind === "automation";

  return (
    <div className="ds-page coming-soon-page">
      <div className="coming-soon-page__back">
        <ButtonLink to="/inbox" variant="ghost" size="sm" icon={<ArrowLeft size={13} />}>
          {zh ? "返回审查工作台" : "Back to review workbench"}
        </ButtonLink>
      </div>
      <EmptyState
        icon={isAutomation ? <Zap size={20} /> : <Puzzle size={20} />}
        title={
          isAutomation
            ? (zh ? "自动化即将接入" : "Automation coming soon")
            : (zh ? "插件市场即将接入" : "Plugins coming soon")
        }
        description={
          isAutomation
            ? (zh
              ? "入口已预留。当前可用工作流 Studio 管理绑定与触发。"
              : "Entry reserved. Use Workflow Studio for bindings and triggers today.")
            : (zh
              ? "扩展点已预留，暂无虚假插件列表。"
              : "Extension points reserved — no fake marketplace listings.")
        }
        action={
          <div className="coming-soon-page__actions">
            {isAutomation ? (
              <ButtonLink to="/workflows" variant="outline" size="sm">
                {zh ? "打开工作流 Studio" : "Open Workflow Studio"}
              </ButtonLink>
            ) : null}
            <ButtonLink to="/inbox" variant="outline" size="sm">
              {zh ? "返回工作台" : "Return to workbench"}
            </ButtonLink>
          </div>
        }
      />
    </div>
  );
}
