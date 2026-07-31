import { ExternalLink, FileDiff, GitCommitHorizontal, GitPullRequest, MessageSquareText, ShieldCheck } from "lucide-react";
import type { RealDataSnapshot } from "../api/client";
import { useI18n } from "../i18n";

function percent(value: number): string { return `${Math.round(value * 1000) / 10}%`; }

function RiskTrend({ data }: { data: RealDataSnapshot }) {
  const { t } = useI18n();
  const commits = data.analysis.commits;
  if (commits.length === 0) return <div className="empty-inline">{t("No analyzed commits are available.")}</div>;
  const width = 760;
  const height = 232;
  const padding = { left: 44, right: 18, top: 20, bottom: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) => padding.left + (commits.length <= 1 ? plotWidth / 2 : index / (commits.length - 1) * plotWidth);
  const y = (risk: number) => padding.top + (1 - risk) * plotHeight;
  const path = commits.map((commit, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(commit.risk_score).toFixed(1)}`).join(" ");
  const maxIndex = commits.reduce((best, commit, index) => commit.risk_score > (commits[best]?.risk_score ?? -1) ? index : best, 0);
  const peak = commits[maxIndex]!;

  return <svg className="real-risk-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("Commit risk trend on a 0 to 1 model scale")}>
    <title>{t("Commit risk trend")}</title><desc>{t("Fourteen analyzed commits plotted in chronological order; higher values indicate greater model-derived drift risk.")}</desc>
    {[0, .25, .5, .75, 1].map(value => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} /><text x={padding.left - 9} y={y(value) + 4} textAnchor="end">{value.toFixed(2)}</text></g>)}
    <path className="risk-trend-line" d={path} />
    {commits.map((commit, index) => <g className={index === maxIndex ? "peak" : ""} key={`${commit.sha}-${index}`}>
      <circle cx={x(index)} cy={y(commit.risk_score)} r={index === maxIndex ? 5 : 3.5}><title>{commit.sha}: {commit.risk_score.toFixed(4)} · {commit.message}</title></circle>
      {(index === 0 || index === commits.length - 1 || index === maxIndex) && <text className="commit-label" x={x(index)} y={height - 18} textAnchor={index === 0 ? "start" : index === commits.length - 1 ? "end" : "middle"}>{commit.sha.slice(0, 7)}</text>}
    </g>)}
    <text className="peak-label" x={x(maxIndex)} y={Math.max(14, y(peak.risk_score) - 10)} textAnchor="middle">{t("Peak")} {peak.risk_score.toFixed(3)}</text>
  </svg>;
}

export function RealDataPage({ data }: { data?: RealDataSnapshot }) {
  const { locale, t } = useI18n();
  if (!data) return <div className="empty-state real-data-empty"><strong>{t("No verified data snapshot is available.")}</strong><span>{t("Run {command}, then refresh this page.", { command: "npm run data:import" })}</span></div>;
  const source = data.source;
  const topFiles = data.analysis.topRiskyFiles;
  const maxFileRisk = Math.max(...topFiles.map(file => file.max_risk), 1);
  const overlap = data.validation.predictedTopFiles.filter(file => data.validation.goldTopFiles.includes(file)).length;
  const imported = new Date(data.importedAt).toLocaleString(locale);
  const fetched = new Date(source.fetchedAt).toLocaleString(locale);

  return <div className="page-stack real-data-page">
    <section className="real-data-header section-block">
      <div><span className="eyebrow"><ShieldCheck size={15} />{t("Verified public source")}</span><h2>{source.repository} · PR #{source.pullRequestNumber}</h2><p>{source.title}</p></div>
      <a className="source-link" href={source.url} target="_blank" rel="noreferrer">{t("Open source PR")}<ExternalLink size={14} /></a>
      <div className="provenance-line"><span>{t("GitHub fetched")}: {fetched}</span><span>{t("Imported locally")}: {imported}</span><span>{t("SHA match")}: <code>{source.baseSha.slice(0, 7)}…{source.headSha.slice(0, 7)}</code></span></div>
    </section>

    <section className="metric-grid real-fact-grid" aria-label={t("Observed GitHub facts")}>
      <article className="metric-card"><div className="metric-icon metric-icon-green"><GitCommitHorizontal size={19} /></div><div className="metric-copy"><span>{t("Commits")}</span><strong>{source.commits}</strong></div><small>{t("Matches analyzed commit count")}</small></article>
      <article className="metric-card"><div className="metric-icon metric-icon-blue"><FileDiff size={19} /></div><div className="metric-copy"><span>{t("Changed files")}</span><strong>{source.changedFiles}</strong></div><small>+{source.additions.toLocaleString(locale)} / −{source.deletions.toLocaleString(locale)}</small></article>
      <article className="metric-card"><div className="metric-icon metric-icon-amber"><MessageSquareText size={19} /></div><div className="metric-copy"><span>{t("Public reviews")}</span><strong>{source.reviewCount}</strong></div><small>{t("GitHub review records")}</small></article>
      <article className="metric-card"><div className="metric-icon metric-icon-success"><GitPullRequest size={19} /></div><div className="metric-copy"><span>{t("Merged")}</span><strong>{source.mergedAt ? t("Yes") : t("No")}</strong></div><small>{source.mergedAt ? new Date(source.mergedAt).toLocaleDateString(locale) : source.state}</small></article>
    </section>

    <section className="section-block real-chart-section">
      <div className="section-heading"><div><span className="panel-kicker">{t("Model-derived · 0–1 scale")}</span><h2>{t("Commit risk trend")}</h2><p>{t("Risk values come from the imported ConsistenCy analysis report, not from GitHub.")}</p></div><div className="chart-summary"><strong>{percent(data.analysis.averageRisk)}</strong><span>{t("average risk")}</span><strong>{percent(data.analysis.maxRisk)}</strong><span>{t("maximum risk")}</span></div></div>
      <RiskTrend data={data} />
    </section>

    <section className="real-data-split">
      <article className="section-block real-files">
        <div className="section-heading"><div><span className="panel-kicker">{t("Model-derived ranking")}</span><h2>{t("Highest-risk files")}</h2><p>{t("Bar length uses each file's maximum risk on the same 0–1 scale.")}</p></div></div>
        <div className="real-file-list">{topFiles.slice(0, 6).map(file => <div className="real-file-row" key={file.file}><div><strong>{file.file}</strong><span>{file.owner ?? t("Unknown owner")} · {file.churn_lines ?? 0} {t("changed lines")}</span></div><div className="file-risk-track"><i style={{ width: `${file.max_risk / maxFileRisk * 100}%` }} /></div><code>{file.max_risk.toFixed(3)}</code></div>)}</div>
      </article>

      <article className="section-block validation-panel">
        <div className="section-heading"><div><span className="panel-kicker">{t("Public-review weak labels")}</span><h2>{t("Validation boundary")}</h2><p>{t("This is a limited benchmark signal, not ground truth.")}</p></div></div>
        <div className="validation-plot" aria-label={t("Precision and recall at K")}>
          <div><span>Precision@{data.validation.k}</span><strong>{percent(data.validation.precisionAtK)}</strong><i><b style={{ width: `${data.validation.precisionAtK * 100}%` }} /></i></div>
          <div><span>Recall@{data.validation.k}</span><strong>{percent(data.validation.recallAtK)}</strong><i><b style={{ width: `${data.validation.recallAtK * 100}%` }} /></i></div>
        </div>
        <p className="validation-note">{t("{overlap} of the top {k} predicted files overlap with {gold} public-review reference files. Evaluated sample: {evaluated}/{total}; manual audit required.", { overlap, k: data.validation.k, gold: data.validation.goldTopFiles.length, evaluated: data.validation.evaluatedCount, total: data.validation.sampleCount })}</p>
        <dl className="source-details"><div><dt>{t("Dataset")}</dt><dd>{data.validation.sourceDataset}</dd></div><div><dt>{t("Label source")}</dt><dd>{data.validation.labelSource.replaceAll("_", " ")}</dd></div><div><dt>{t("Analysis file")}</dt><dd><code>{data.analysis.reportPath}</code></dd></div></dl>
      </article>
    </section>
  </div>;
}
