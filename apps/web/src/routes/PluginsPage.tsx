import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Puzzle, ShieldCheck, Workflow } from "lucide-react";
import { BUILTIN_ANALYZER_REGISTRY } from "@consistency/plugins-builtin/registry";
import { api } from "../api/client";
import { Badge } from "../design-system/Badge";
import { ButtonLink } from "../design-system/Button";
import { useI18n } from "../i18n";
import { workspaceQueryKeys } from "../query/client";

/**
 * Mature Plugins surface: list real builtin / installed analyzers from
 * `@consistency/plugins-builtin` registry (+ engine allowlist kinds when API
 * is available). No fake marketplace / install store.
 */
export function PluginsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";

  const allowlistQuery = useQuery({
    queryKey: workspaceQueryKeys.catalogEngineAllowlist,
    queryFn: ({ signal }) => api.engineAllowlistCatalog(signal),
    retry: false
  });

  const engineAnalyzers = allowlistQuery.data?.catalog.analyzers ?? [];
  const engineVerifiers = allowlistQuery.data?.catalog.verifiers ?? [];

  return (
    <div className="ds-page coming-soon-page coming-soon-page--product plugins-page" data-testid="plugins-page">
      <div className="coming-soon-page__back">
        <ButtonLink to="/inbox" variant="ghost" size="sm" icon={<ArrowLeft size={13} />}>
          {zh ? "返回审查工作台" : "Back to review workbench"}
        </ButtonLink>
      </div>

      <header className="coming-soon-hero">
        <div className="coming-soon-hero__icon" aria-hidden="true">
          <Puzzle size={22} />
        </div>
        <div className="coming-soon-hero__copy">
          <div className="coming-soon-hero__kicker">
            <Badge variant="neutral" size="sm">{zh ? "内置分析器" : "Builtin analyzers"}</Badge>
            <span className="coming-soon-hero__meta">
              {zh
                ? `${BUILTIN_ANALYZER_REGISTRY.length} 个内置 · 第三方市场稍后`
                : `${BUILTIN_ANALYZER_REGISTRY.length} builtin · third-party marketplace later`}
            </span>
          </div>
          <h1 className="coming-soon-hero__title">{zh ? "插件" : "Plugins"}</h1>
          <p className="coming-soon-hero__desc">
            {zh
              ? "展示仓库里真实可用的确定性分析器（来自 @consistency/plugins-builtin）。不提供虚假安装商店；第三方市场属于后续里程碑。"
              : "Lists deterministic analyzers actually shipped in @consistency/plugins-builtin. No fake install store — a third-party marketplace is a later milestone."}
          </p>
        </div>
      </header>

      <section className="plugins-registry" aria-label={zh ? "内置分析器" : "Builtin analyzers"}>
        <div className="plugins-registry__head">
          <h2>{zh ? "已安装 / 内置分析器" : "Installed / builtin analyzers"}</h2>
          <p>
            {zh
              ? "元数据来自插件包注册表，与审查运行时使用的分析器一致。"
              : "Metadata from the plugin package registry — same analyzers the review runtime uses."}
          </p>
        </div>
        <ul className="plugins-registry__list">
          {BUILTIN_ANALYZER_REGISTRY.map(analyzer => (
            <li key={analyzer.id} data-testid={`plugin-builtin-${analyzer.id}`}>
              <div className="plugins-registry__icon" aria-hidden="true">
                <ShieldCheck size={16} />
              </div>
              <div className="plugins-registry__main">
                <strong>{zh ? analyzer.titleZh : analyzer.title}</strong>
                <span className="plugins-registry__meta mono">
                  {analyzer.id}@{analyzer.version} · {analyzer.packageName}
                </span>
                <p>{zh ? analyzer.summaryZh : analyzer.summary}</p>
              </div>
              <Badge variant="neutral" size="sm">{zh ? "确定性" : "deterministic"}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section className="coming-soon-grid" aria-label={zh ? "边界说明" : "Boundaries"}>
        <article className="coming-soon-card">
          <header>
            <Workflow size={16} />
            <h2>{zh ? "引擎允许列表种类" : "Engine allowlist kinds"}</h2>
          </header>
          {allowlistQuery.isError ? (
            <p>{zh ? "目录暂不可用（API 未就绪或未授权）。" : "Catalog unavailable (API not ready or unauthorized)."}</p>
          ) : allowlistQuery.isLoading ? (
            <p>{zh ? "加载引擎目录…" : "Loading engine catalog…"}</p>
          ) : (
            <>
              <p>
                {zh
                  ? `工作流引擎允许的分析器种类 ${engineAnalyzers.length} 个、校验器 ${engineVerifiers.length} 个（只读投影，非商店）。`
                  : `${engineAnalyzers.length} analyzer kind(s) and ${engineVerifiers.length} verifier kind(s) from the engine allowlist (read-only projection — not a store).`}
              </p>
              <ul className="plugins-engine-kinds">
                {engineAnalyzers.slice(0, 12).map(kind => (
                  <li key={kind} className="mono">{kind}</li>
                ))}
              </ul>
            </>
          )}
          <ButtonLink to="/workflows" variant="outline" size="sm">
            {zh ? "查看工作流运行时" : "View workflow runtime"}
          </ButtonLink>
        </article>
        <article className="coming-soon-card">
          <header>
            <Puzzle size={16} />
            <h2>{zh ? "第三方市场稍后" : "Third-party marketplace later"}</h2>
          </header>
          <p>
            {zh
              ? "不会在此展示虚假可安装条目。扩展点将走 Kernel 能力与沙箱边界后再开放。"
              : "We will not show fake installable entries here. Extension points will open only after Kernel capability and sandbox boundaries land."}
          </p>
        </article>
        <article className="coming-soon-card">
          <header>
            <ShieldCheck size={16} />
            <h2>{zh ? "回到工作台" : "Back to workbench"}</h2>
          </header>
          <p>
            {zh
              ? "日常审查仍从左侧仓库与「开始审查」进入；插件页不会抢走主路径。"
              : "Day-to-day review still starts from the left repo list and Start Review; this page will not steal the primary path."}
          </p>
          <ButtonLink to="/inbox" variant="outline" size="sm">
            {zh ? "返回工作台" : "Return to workbench"}
          </ButtonLink>
        </article>
      </section>
    </div>
  );
}
