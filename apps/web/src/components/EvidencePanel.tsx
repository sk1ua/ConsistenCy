import type { RetrievalTrace } from "@consistency/schema";
import { Archive, GitPullRequestArrow, Layers3 } from "lucide-react";
import { useI18n } from "../i18n";

function percent(value?: number): string {
  if (value === undefined) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function formatCandidateKind(kind: string, zh: boolean): { human: string; raw: string } {
  switch (kind) {
    case "changed_hunk":
    case "CHANGED_HUNK":
      return { human: zh ? "代码变更" : "Code Change", raw: "CHANGED_HUNK" };
    case "agent_finding":
    case "AGENT_FINDING":
      return { human: zh ? "智能体发现" : "Agent Finding", raw: "AGENT_FINDING" };
    case "history_signal":
    case "HISTORY_SIGNAL":
      return { human: zh ? "历史信号" : "History Signal", raw: "HISTORY_SIGNAL" };
    case "file_snippet":
    case "FILE_SNIPPET":
      return { human: zh ? "文件片段" : "File Snippet", raw: "FILE_SNIPPET" };
    default:
      return { human: kind, raw: kind.toUpperCase() };
  }
}

export function EvidencePanel({ retrieval }: { retrieval?: RetrievalTrace }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";

  if (!retrieval || retrieval.packs.length === 0) {
    return (
      <article className="section-block evidence-panel">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "上下文层" : "Context layer"}</span>
            <h2>{zh ? "证据检索" : "Evidence retrieval"}</h2>
          </div>
        </div>
        <div className="empty-inline">{zh ? "该报告暂无可用的证据包。" : "No evidence packs are available for this report."}</div>
      </article>
    );
  }

  const [firstPack] = retrieval.packs;
  if (!firstPack) {
    return (
      <article className="section-block evidence-panel">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "上下文层" : "Context layer"}</span>
            <h2>{zh ? "证据检索" : "Evidence retrieval"}</h2>
          </div>
        </div>
        <div className="empty-inline">{zh ? "该报告暂无可用的证据包。" : "No evidence packs are available for this report."}</div>
      </article>
    );
  }

  const selected = firstPack.selected_evidence.slice(0, 3);
  const discarded = firstPack.discarded_candidates.slice(0, 3);
  const summary = retrieval.summary;

  return (
    <article className="section-block evidence-panel">
      {/* 1. Panel Header with Human Strategy Label */}
      <div className="panel-title">
        <div>
          <span className="panel-kicker">{zh ? "上下文证据" : "Context Evidence"}</span>
          <h2>
            {zh ? "证据检索与排序" : "Evidence Retrieval & Ranking"}
            <span className="sub-title-note">{zh ? "可解释的上下文选择" : "Explainable context selection"}</span>
          </h2>
        </div>
        <span className="strategy-pill" title={retrieval.strategy}>
          {zh ? "混合检索 · 多信号融合" : "Hybrid Retrieval · Multi-Signal"}
        </span>
      </div>

      {/* 2. Compact Metrics Summary */}
      <div className="evidence-summary-grid">
        <div>
          <Layers3 size={16} />
          <span>{zh ? "上下文预算" : "Context budget"}</span>
          <strong>{retrieval.context_budget_tokens.toLocaleString(locale)} {zh ? "个令牌" : "tokens"}</strong>
        </div>
        <div>
          <Archive size={16} />
          <span>{zh ? "证据压缩率" : "Compression"}</span>
          <strong>{percent(summary.average_compression_ratio)}</strong>
        </div>
        <div>
          <GitPullRequestArrow size={16} />
          <span>{zh ? "包含证据的文件" : "Files with evidence"}</span>
          <strong>{summary.files_with_evidence}</strong>
        </div>
      </div>

      {/* 3. Evidence Focus & Cards */}
      <div className="evidence-pack-card">
        <div className="evidence-pack-header">
          <div>
            <span>{zh ? "证据焦点文件" : "Evidence focus"}</span>
            <strong>{firstPack.file}</strong>
          </div>
          <code className="risk-terms-chip">{firstPack.query.risk_terms.join(" / ") || (zh ? "路径匹配" : "path match")}</code>
        </div>
        <p className="evidence-query">{firstPack.query.natural_query}</p>

        <div className="evidence-columns">
          {/* Selected Evidence (Human Labels First) */}
          <div className="evidence-col">
            <h3>{zh ? "已选证据" : "Selected evidence"} <span>{selected.length}</span></h3>
            {selected.map(item => {
              const kindInfo = formatCandidateKind(item.candidate.kind, zh);
              return (
                <div className="evidence-item" key={item.candidate.id}>
                  <div className="evidence-kind-row">
                    <span className="evidence-human-kind">{kindInfo.human}</span>
                    <code className="evidence-raw-kind">{kindInfo.raw}</code>
                  </div>
                  <strong className="evidence-source-title">{item.candidate.source}</strong>
                  <p className="evidence-code-content">{item.candidate.content}</p>
                  <small className="evidence-why-reason">
                    {zh ? `选择原因: ${item.why_selected.join("; ")}` : `Why selected: ${item.why_selected.join("; ")}`}
                  </small>
                </div>
              );
            })}
          </div>

          {/* Excluded Context */}
          <div className="evidence-col">
            <h3>{zh ? "排除的上下文" : "Excluded context"} <span>{discarded.length}</span></h3>
            {discarded.length === 0 ? (
              <p className="muted-copy">{zh ? "无被舍弃的候选片段。" : "No discarded candidates."}</p>
            ) : (
              discarded.map(item => {
                const kindInfo = formatCandidateKind(item.kind, zh);
                return (
                  <div className="discarded-item" key={item.candidate_id}>
                    <div className="discarded-head">
                      <span className="discarded-kind">{kindInfo.human}</span>
                      <strong>{item.score.toFixed(2)}</strong>
                    </div>
                    <small>{item.why_discarded.join("; ")}</small>
                  </div>
                );
              })
            )}

            <div className="agent-grounding">
              <span>{zh ? "智能体决策依据" : "Agent decision grounding"}</span>
              <p>{zh ? "确定性分析器遵循专用规则集运行；证据包为大语言模型合成提供紧凑的项目上下文。" : "Specialist deterministic analyzers keep their own rules; the evidence pack supplies compact project context."}</p>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
