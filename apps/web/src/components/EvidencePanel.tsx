import type { RetrievalTrace } from "@consistency/schema";
import { Archive, GitPullRequestArrow, Layers3 } from "lucide-react";

function percent(value?: number): string {
  if (value === undefined) return "n/a";
  return `${Math.round(value * 100)}%`;
}

export function EvidencePanel({ retrieval }: { retrieval?: RetrievalTrace }) {
  if (!retrieval || retrieval.packs.length === 0) {
    return <article className="section-block evidence-panel">
      <div className="panel-title"><h2>Evidence retrieval</h2></div>
      <div className="empty-inline">No evidence packs are available for this report.</div>
    </article>;
  }

  const [firstPack] = retrieval.packs;
  if (!firstPack) {
    return <article className="section-block evidence-panel">
      <div className="panel-title"><h2>Evidence retrieval</h2></div>
      <div className="empty-inline">No evidence packs are available for this report.</div>
    </article>;
  }
  const selected = firstPack.selected_evidence.slice(0, 3);
  const discarded = firstPack.discarded_candidates.slice(0, 3);
  const summary = retrieval.summary;

  return <article className="section-block evidence-panel">
    <div className="panel-title">
      <h2>Evidence retrieval <span>({retrieval.strategy})</span></h2>
    </div>
    <div className="evidence-summary-grid">
      <div><Layers3 size={16} /><span>Context budget</span><strong>{retrieval.context_budget_tokens.toLocaleString()} tokens</strong></div>
      <div><Archive size={16} /><span>Evidence compression</span><strong>{percent(summary.average_compression_ratio)}</strong></div>
      <div><GitPullRequestArrow size={16} /><span>Files with evidence</span><strong>{summary.files_with_evidence}</strong></div>
    </div>
    <div className="evidence-pack-card">
      <div className="evidence-pack-header">
        <div><span>Why this file was retrieved</span><strong>{firstPack.file}</strong></div>
        <code>{firstPack.query.risk_terms.join(" / ") || "path match"}</code>
      </div>
      <p className="evidence-query">{firstPack.query.natural_query}</p>
      <div className="evidence-columns">
        <div>
          <h3>Selected evidence</h3>
          {selected.map(item => <div className="evidence-item" key={item.candidate.id}>
            <span>{item.candidate.kind}</span>
            <strong>{item.candidate.source}</strong>
            <p>{item.candidate.content}</p>
            <small>Why this evidence was selected: {item.why_selected.join("; ")}</small>
          </div>)}
        </div>
        <div>
          <h3>What was ignored</h3>
          {discarded.length === 0 ? <p className="muted-copy">No discarded candidates.</p> : discarded.map(item => <div className="discarded-item" key={item.candidate_id}>
            <span>{item.kind}</span>
            <strong>{item.score.toFixed(2)}</strong>
            <small>{item.why_discarded.join("; ")}</small>
          </div>)}
          <div className="agent-grounding">
            <span>Agent decision grounding</span>
            <p>Specialist deterministic analyzers keep their own rules; the evidence pack supplies compact project context for reviewer handoff.</p>
          </div>
        </div>
      </div>
    </div>
  </article>;
}
