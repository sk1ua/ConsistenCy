import type { ReviewJob, ReviewReport } from "@consistency/schema";
import { CheckCircle2, FileSearch2, GitBranch, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { FindingItem } from "../components/FindingItem";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../i18n";
import { bindReportToJob } from "./reportIntegrity";
import { Link } from "react-router-dom";

function formatReviewSource(job: ReviewJob, zh: boolean): { sourceText: string; publicationText: string } {
  if (job.accessMode === "local_git") {
    return {
      sourceText: zh ? "本地工作区" : "Local workspace",
      publicationText: zh ? "仅分析" : "Analysis only"
    };
  }

  if (job.accessMode === "public_read") {
    return {
      sourceText: zh ? "GitHub 公开只读" : "GitHub public read",
      publicationText: zh ? "仅分析" : "Analysis only"
    };
  }

  return {
    sourceText: "GitHub App",
    publicationText: job.publicationPolicy === "disabled" ? (zh ? "仅分析" : "Analysis only") : (zh ? "GitHub 评论" : "GitHub comment")
  };
}

export function ReportPage({
  job,
  report,
  llmProvider,
  llmModel
}: {
  job?: ReviewJob;
  report?: ReviewReport;
  notebookId?: string;
  llmProvider?: string;
  llmModel?: string;
  onBack?: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const [groupBy, setGroupBy] = useState<"severity" | "agent">("severity");

  const binding = useMemo(() => job ? bindReportToJob(job, report) : { status: "missing" as const }, [job, report]);
  const boundReport = binding.status === "bound" ? binding.report : undefined;

  const provenance = job ? formatReviewSource(job, zh) : { sourceText: "—", publicationText: "—", isFixture: false };

  const groups = useMemo(() => {
    if (!boundReport) return [];
    const map = new Map<string, typeof boundReport.findings>();
    for (const finding of boundReport.findings) {
      const key = groupBy === "severity" ? finding.severity : finding.agent;
      const current = map.get(key);
      if (current) current.push(finding);
      else map.set(key, [finding]);
    }
    return [...map.entries()];
  }, [boundReport, groupBy]);

  if (!job) return <div className="empty-state">{t("Select a review job to inspect its report.")}</div>;

  return (
    <div className="page-stack report-page review-overview-page">
      {binding.status === "mismatch" && (
        <div className="report-integrity-alert" role="alert">
          <ShieldAlert size={18} />
          <span><strong>{zh ? "报告完整性校验未通过" : "Report integrity check failed."}</strong> {zh ? "该报告与选定的审查任务不匹配，已拒绝展示。" : "The report does not belong to the selected job."}</span>
        </div>
      )}

      {/* 1. Review Summary Hero Header */}
      <section className="section-block review-hero-card">
        <div className="review-hero-primary-row">
          <div className="review-hero-info">
            <div className="review-hero-tags">
              <span className="provenance-pill">{zh ? "审查" : "REVIEW"}</span>
              <span className="provenance-pill subtle">{job.repositoryFullName}</span>
            </div>
            <h2>
              {job.pullRequestNumber === undefined ? (zh ? "本地工作区审查" : "Local Repository Review") : `PR #${job.pullRequestNumber} · ${zh ? "审查" : "Review"}`}
            </h2>
          </div>

          <div className="review-hero-score-badge">
            <div className="score-main-val">
              <strong>{boundReport?.score ?? "-"}</strong>
              <small>{zh ? "质量评分" : "score"}</small>
            </div>
            {boundReport && <StatusBadge value={boundReport.riskLevel} />}
          </div>
        </div>

        {/* Compact Metadata Strip */}
        <div className="review-meta-strip">
          <div className="meta-item">
            <span className="meta-lbl">{zh ? "代码范围" : "Range"}</span>
            <code>{job.baseSha.slice(0, 7)} → {job.headSha.slice(0, 7)}</code>
          </div>
          <div className="meta-item">
            <span className="meta-lbl">{zh ? "状态" : "Status"}</span>
            <StatusBadge value={job.status} />
          </div>
          <div className="meta-item">
            <span className="meta-lbl">{zh ? "发现数" : "Findings"}</span>
            <strong>{boundReport?.findings.length ?? 0} {zh ? "项" : "items"}</strong>
          </div>
          <div className="meta-item">
            <span className="meta-lbl">{zh ? "模型" : "Model"}</span>
            <code>{llmProvider === "mock" ? (zh ? "Mock 模型" : "Mock model") : (llmProvider ?? t("unavailable"))}{llmModel ? ` · ${llmModel}` : ""}</code>
          </div>
          <div className="meta-item">
            <span className="meta-lbl">{zh ? "来源" : "Source"}</span>
            <span className="meta-text">{provenance.sourceText}</span>
          </div>
          <div className="meta-item">
            <span className="meta-lbl">{zh ? "发布" : "Publication"}</span>
            <span className="meta-text">{provenance.publicationText}</span>
          </div>
        </div>

        {/* Summary Description */}
        <p className="review-summary-text" aria-live="polite">
          {boundReport?.summary ?? job.error ?? (zh ? "审查正在执行中..." : "Review is in progress.")}
        </p>
      </section>

      {/* 2. Overview Main Content: Findings & Highlights */}
      <div className="review-overview-content">
        {/* Left: Findings List */}
        <section className="section-block review-findings-pane" aria-label={t("Findings")}>
          <div className="pane-heading">
            <div className="section-heading">
              <div>
                <h2>{t("Findings")}</h2>
                <p>{zh ? "已核验的缺陷证据、推导与修复建议" : "Evidence, reasoning and remediation"}</p>
              </div>
            </div>
            <div className="segmented" role="group" aria-label={t("Findings")}>
              <button type="button" aria-pressed={groupBy === "severity"} className={groupBy === "severity" ? "active" : ""} onClick={() => setGroupBy("severity")}>{zh ? "严重度" : "Severity"}</button>
              <button type="button" aria-pressed={groupBy === "agent"} className={groupBy === "agent" ? "active" : ""} onClick={() => setGroupBy("agent")}>{zh ? "智能体" : "Agent"}</button>
            </div>
          </div>

          <div className="pane-scroll">
            {!boundReport ? (
              <div className="empty-inline">{zh ? "审查完成后将展示分析发现。" : "Findings will appear when review finishes."}</div>
            ) : groups.length === 0 ? (
              <div className="clean-inline-status">
                <CheckCircle2 size={16} className="icon-success" />
                <span>{zh ? "本次审查未发现代码缺陷。" : "No findings reported."}</span>
              </div>
            ) : (
              groups.map(([group, findings]) => (
                <section className="finding-group" key={group}>
                  <h3>
                    <span>{zh ? (group === "critical" ? "严重" : group === "high" ? "高危" : group === "medium" ? "中危" : group === "low" ? "低危" : group) : group}</span>
                    <span className="count-pill">{findings.length}</span>
                  </h3>
                  {findings.map(finding => (
                    <FindingItem
                      finding={finding}
                      key={finding.id}
                      onLocate={() => undefined}
                    />
                  ))}
                </section>
              ))
            )}
          </div>
        </section>

        {/* Right: Decision & Evidence Summary */}
        <div className="review-sidebar-highlights">
          {/* Decision Summary */}
          {boundReport && (
            <section className="section-block highlight-card">
              <div className="panel-title">
                <div>
                  <span className="panel-kicker">{zh ? "综合判定" : "Decision"}</span>
                  <h2>{zh ? "处置建议" : "Recommendation"}</h2>
                </div>
                <StatusBadge value={boundReport.riskLevel} />
              </div>
              <div className="highlight-body">
                <p>{boundReport.summary}</p>
                {boundReport.findings.length > 0 && (
                  <div className="remediation-teaser">
                    <span>{zh ? "首要修复建议" : "Primary recommendation"}:</span>
                    <strong>{boundReport.findings[0]?.recommendation}</strong>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Evidence Quick Summary */}
          {boundReport?.retrieval && (
            <section className="section-block highlight-card">
              <div className="panel-title">
                <div>
                  <span className="panel-kicker">{zh ? "上下文证据" : "Evidence"}</span>
                  <h2>{zh ? "证据检索摘要" : "Retrieval Summary"}</h2>
                </div>
                <Link to={`/runs/${encodeURIComponent(job.id)}/evidence`} className="text-link">
                  {zh ? "查看全部证据" : "View evidence"} →
                </Link>
              </div>
              <div className="highlight-body">
                <div className="evidence-quick-stats">
                  <div><span>{zh ? "预算" : "Budget"}:</span> <strong>{boundReport.retrieval.context_budget_tokens.toLocaleString()} tokens</strong></div>
                  <div><span>{zh ? "压缩率" : "Compression"}:</span> <strong>{Math.round((boundReport.retrieval.summary.average_compression_ratio ?? 0) * 100)}%</strong></div>
                  <div><span>{zh ? "包含文件" : "Files"}:</span> <strong>{boundReport.retrieval.summary.files_with_evidence}</strong></div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
