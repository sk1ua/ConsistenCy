import type { RetrievalTrace } from "@consistency/schema";
import { Archive, GitPullRequestArrow, Layers3 } from "lucide-react";
import { useI18n } from "../i18n";

function percent(value?: number): string {
  if (value === undefined) return "n/a";
  return `${Math.round(value * 100)}%`;
}

export function EvidencePanel({ retrieval }: { retrieval?: RetrievalTrace }) {
  const { locale, t } = useI18n();
  if (!retrieval || retrieval.packs.length === 0) {
    return <article className="section-block evidence-panel">
      <div className="panel-title"><div><span className="panel-kicker">{t("Context layer")}</span><h2>{t("Evidence retrieval")}</h2></div></div>
      <div className="empty-inline">{t("No evidence packs are available for this report.")}</div>
    </article>;
  }

  const [firstPack] = retrieval.packs;
  if (!firstPack) {
    return <article className="section-block evidence-panel">
      <div className="panel-title"><div><span className="panel-kicker">{t("Context layer")}</span><h2>{t("Evidence retrieval")}</h2></div></div>
      <div className="empty-inline">{t("No evidence packs are available for this report.")}</div>
    </article>;
  }
  const selected = firstPack.selected_evidence.slice(0, 3);
  const discarded = firstPack.discarded_candidates.slice(0, 3);
  const summary = retrieval.summary;

  return <article className="section-block evidence-panel">
    <div className="panel-title">
      <div><span className="panel-kicker">{t("Context layer")}</span><h2>{t("Evidence retrieval")} <span>{t("Explainable context selection")}</span></h2></div>
      <code className="strategy-label" title={retrieval.strategy}>{retrieval.strategy.replaceAll("_", " ")}</code>
    </div>
    <div className="evidence-summary-grid">
      <div><Layers3 size={16} /><span>{t("Context budget")}</span><strong>{t("{count} tokens", { count: retrieval.context_budget_tokens.toLocaleString(locale) })}</strong></div>
      <div><Archive size={16} /><span>{t("Evidence compression")}</span><strong>{percent(summary.average_compression_ratio)}</strong></div>
      <div><GitPullRequestArrow size={16} /><span>{t("Files with evidence")}</span><strong>{summary.files_with_evidence}</strong></div>
    </div>
    <div className="evidence-pack-card">
      <div className="evidence-pack-header">
        <div><span>{t("Evidence focus")}</span><strong>{firstPack.file}</strong></div>
        <code>{firstPack.query.risk_terms.join(" / ") || t("path match")}</code>
      </div>
      <p className="evidence-query">{firstPack.query.natural_query}</p>
      <div className="evidence-columns">
        <div>
          <h3>{t("Selected evidence")} <span>{selected.length}</span></h3>
          {selected.map(item => <div className="evidence-item" key={item.candidate.id}>
            <span>{item.candidate.kind}</span>
            <strong>{item.candidate.source}</strong>
            <p>{item.candidate.content}</p>
            <small>{t("Why this evidence was selected: {reason}", { reason: item.why_selected.join("; ") })}</small>
          </div>)}
        </div>
        <div>
          <h3>{t("Excluded context")} <span>{discarded.length}</span></h3>
          {discarded.length === 0 ? <p className="muted-copy">{t("No discarded candidates.")}</p> : discarded.map(item => <div className="discarded-item" key={item.candidate_id}>
            <span>{item.kind}</span>
            <strong>{item.score.toFixed(2)}</strong>
            <small>{item.why_discarded.join("; ")}</small>
          </div>)}
          <div className="agent-grounding">
            <span>{t("Agent decision grounding")}</span>
            <p>{t("Specialist deterministic analyzers keep their own rules; the evidence pack supplies compact project context for reviewer handoff.")}</p>
          </div>
        </div>
      </div>
    </div>
  </article>;
}
