import React from "react";
import { Puzzle, Zap } from "lucide-react";
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
      <EmptyState
        icon={isAutomation ? <Zap size={28} /> : <Puzzle size={28} />}
        title={
          isAutomation
            ? (zh ? "自动化 · 即将接入" : "Automation · Coming soon")
            : (zh ? "插件市场 · 即将接入" : "Plugin marketplace · Coming soon")
        }
        description={
          isAutomation
            ? (zh
              ? "自动化编排入口已预留。当前可通过工作流 Studio（Cmd+K → Workflows）管理绑定与触发。"
              : "Automation entry is reserved. Use Workflow Studio (Cmd+K → Workflows) for bindings and triggers today.")
            : (zh
              ? "插件市场尚未上线。Cordis 扩展点已预留，不会展示虚假插件数据。"
              : "Plugin marketplace is not live yet. Cordis extension points are reserved; no fake listings.")
        }
        action={
          isAutomation ? (
            <ButtonLink to="/workflows" variant="outline" size="sm">
              {zh ? "打开工作流 Studio" : "Open Workflow Studio"}
            </ButtonLink>
          ) : undefined
        }
      />
    </div>
  );
}
