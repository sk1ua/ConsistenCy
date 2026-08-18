import { useState, useMemo } from "react";
import type { ReviewReport, Severity } from "@consistency/schema";
import { AlertTriangle, FileSearch2, Search, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { FindingItem } from "../components/FindingItem";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export function FindingsPage({ reports, reportsUnavailable }: { reports: ReviewReport[]; reportsUnavailable: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const allFindings = useMemo(() => {
    return reports.flatMap(report => report.findings.map(finding => ({ finding, report })))
      .sort((left, right) => (SEVERITY_ORDER[right.finding.severity] ?? 0) - (SEVERITY_ORDER[left.finding.severity] ?? 0));
  }, [reports]);

  const filtered = useMemo(() => {
    return allFindings.filter(({ finding, report }) => {
      const matchSeverity = severityFilter === "all" || finding.severity === severityFilter;
      const matchSearch = !search.trim() ||
        finding.title.toLowerCase().includes(search.toLowerCase()) ||
        finding.file.toLowerCase().includes(search.toLowerCase()) ||
        report.repositoryFullName.toLowerCase().includes(search.toLowerCase());
      return matchSeverity && matchSearch;
    });
  }, [allFindings, search, severityFilter]);

  return (
    <div className="findings-route page-stack">
      {/* 1. Clean Developer Header */}
      <section className="section-block findings-header-strip">
        <div className="findings-title-wrap">
          <FileSearch2 size={20} className="findings-icon-main" />
          <div>
            <h2>{zh ? "发现索引" : "Findings Index"}</h2>
            <p>{zh ? "跨所有代码仓库与审查聚合的静态及语义分析发现。" : "Aggregated static and semantic findings across all reviewed repositories."}</p>
          </div>
        </div>

        <div className="findings-filter-bar">
          <div className="search-input-wrap">
            <Search size={14} className="search-icon" />
            <input
              type="text"
              placeholder={zh ? "搜索发现、文件或仓库..." : "Search findings, files..."}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value)}
            className="filter-select"
            aria-label={zh ? "严重度筛选" : "Severity filter"}
          >
            <option value="all">{zh ? "全部严重度" : "All severities"}</option>
            <option value="critical">{zh ? "严重 (Critical)" : "Critical"}</option>
            <option value="high">{zh ? "高危 (High)" : "High"}</option>
            <option value="medium">{zh ? "中危 (Medium)" : "Medium"}</option>
            <option value="low">{zh ? "低危 (Low)" : "Low"}</option>
          </select>
        </div>
      </section>

      {/* 2. Findings List */}
      <section className="section-block findings-catalog">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "发现列表" : "Findings List"}</span>
            <h2>{zh ? "代码缺陷与安全建议" : "Code Issues & Recommendations"}</h2>
          </div>
          <strong>{filtered.length} {zh ? "项" : "items"}</strong>
        </div>

        {reportsUnavailable && allFindings.length === 0 ? (
          <div className="honest-fallback-box">
            <AlertTriangle size={18} className="icon-warning" />
            <div>
              <strong>{zh ? "报告数据暂不可用" : "Report Data Unavailable"}</strong>
              <p>{zh ? "恢复报告 API 后重试；当前不展示未经核验的推测发现。" : "Retry after the report API recovers."}</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="clean-inline-status">
            <ShieldCheck size={18} className="icon-success" />
            <span>{zh ? "当前无匹配的审查发现。" : "No matching findings in reviewed reports."}</span>
          </div>
        ) : (
          <div className="findings-catalog-list">
            {filtered.map(({ finding, report }) => {
              const isDemo = report.jobId.startsWith("job_demo");
              return (
                <article className="catalog-finding-card" key={`${report.jobId}:${finding.id}`}>
                  <div className="catalog-finding-source">
                    <div className="source-left">
                      <strong>{report.repositoryFullName}</strong>
                      <small>{report.pullRequestNumber ? `PR #${report.pullRequestNumber}` : (zh ? "本地审查" : "Local review")}</small>
                      {isDemo && <span className="provenance-pill demo-provenance">{zh ? "演示数据" : "FIXTURE"}</span>}
                    </div>
                    <Link to={`/runs/${encodeURIComponent(report.jobId)}/diff`} className="text-link">
                      {zh ? "查看代码差异" : "View Diff"} →
                    </Link>
                  </div>
                  <FindingItem finding={finding} />
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
