import type { ReviewReport } from "@consistency/schema";
import { AlertTriangle, FileSearch2, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { FindingItem } from "../components/FindingItem";
import { useI18n } from "../i18n";

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;

export function FindingsPage({ reports, reportsUnavailable }: { reports: ReviewReport[]; reportsUnavailable: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const findings = reports.flatMap(report => report.findings.map(finding => ({ finding, report })))
    .sort((left, right) => SEVERITY_ORDER[right.finding.severity] - SEVERITY_ORDER[left.finding.severity]);

  return <div className="findings-route page-stack">
    <section className="findings-intro section-block">
      <div><span className="panel-kicker"><ShieldCheck size={14} />{zh ? "证据索引" : "Evidence index"}</span><h2>{zh ? "跨审查汇总现有发现。" : "Existing findings across review runs."}</h2><p>{zh ? "这里仅聚合 API 返回的报告发现。风险与置信度用于分流；置信度为 0 或缺少行号的条目仍需人工核验。" : "This view only aggregates findings returned by report APIs. Risk and confidence are triage signals; confidence-zero or line-free entries still require manual review."}</p></div>
      <div className="findings-count"><strong>{findings.length}</strong><span>{zh ? "条可追溯发现" : "traceable findings"}</span></div>
    </section>
    <section className="section-block findings-catalog">
      <div className="panel-title"><div><span className="panel-kicker"><FileSearch2 size={14} />{zh ? "报告证据" : "Report evidence"}</span><h2>{zh ? "发现目录" : "Findings catalog"}</h2></div></div>
      {reportsUnavailable && findings.length === 0 ? <div className="repository-honest-empty"><AlertTriangle size={20} /><div><strong>{zh ? "发现来源暂不可用" : "Finding sources are unavailable"}</strong><p>{zh ? "恢复报告 API 后重试；当前不展示缓存外的推测发现。" : "Retry after the report API recovers. No speculative findings are shown."}</p></div></div>
        : findings.length === 0 ? <div className="repository-honest-empty"><ShieldCheck size={20} /><div><strong>{zh ? "现有报告没有发现" : "No findings in current reports"}</strong><p>{zh ? "完成一次产生报告的审查后，证据会出现在这里。" : "Evidence will appear after a review produces a report."}</p></div></div>
        : <div className="findings-catalog-list">{findings.map(({ finding, report }) => <article className="catalog-finding" key={`${report.jobId}:${finding.id}`}>
          <div className="catalog-finding-source"><span><strong>{report.repositoryFullName}</strong><small>{report.pullRequestNumber ? `PR #${report.pullRequestNumber}` : (zh ? "本地审查" : "Local review")}</small></span><Link to={`/runs/${encodeURIComponent(report.jobId)}/evidence`}>{zh ? "打开运行证据" : "Open run evidence"}</Link></div>
          <FindingItem finding={finding} />
        </article>)}</div>}
    </section>
  </div>;
}
