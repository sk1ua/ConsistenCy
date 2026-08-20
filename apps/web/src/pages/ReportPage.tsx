import React, { useMemo, useState } from "react";
import type { ReviewJob, ReviewReport } from "@consistency/schema";
import {
  CheckCircle2,
  FileSearch2,
  GitBranch,
  GitCommit,
  ShieldAlert,
  ShieldCheck,
  Cpu,
  Layers,
  ArrowRight
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { FindingItem } from "../components/FindingItem";
import { useI18n } from "../i18n";
import { bindReportToJob } from "./reportIntegrity";
import { Button } from "../design-system/Button";
import { Badge } from "../design-system/Badge";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";
import { AppLink } from "../design-system/Link";

function formatReviewSource(job: ReviewJob, zh: boolean): { sourceText: string; publicationText: string } {
  if (job.accessMode === "local_git") {
    return {
      sourceText: zh ? "本地工作区 (Local Git)" : "Local workspace",
      publicationText: zh ? "仅分析" : "Analysis only"
    };
  }

  if (job.accessMode === "public_read") {
    return {
      sourceText: zh ? "GitHub 公开只读 (Public Read)" : "GitHub public read",
      publicationText: zh ? "仅分析" : "Analysis only"
    };
  }

  return {
    sourceText: "GitHub App",
    publicationText:
      job.publicationPolicy === "disabled"
        ? zh ? "仅分析" : "Analysis only"
        : zh ? "GitHub 评论" : "GitHub comment"
  };
}

export interface ReportPageProps {
  job?: ReviewJob;
  report?: ReviewReport;
  notebookId?: string;
  llmProvider?: string;
  llmModel?: string;
  onBack?: () => void;
}

export const ReportPage: React.FC<ReportPageProps> = ({
  job,
  report,
  llmProvider,
  llmModel
}) => {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const [groupBy, setGroupBy] = useState<"severity" | "agent">("severity");

  const binding = useMemo(() => (job ? bindReportToJob(job, report) : { status: "missing" as const }), [job, report]);
  const boundReport = binding.status === "bound" ? binding.report : undefined;

  const provenance = job ? formatReviewSource(job, zh) : { sourceText: "—", publicationText: "—" };
  const resolvedProvider = boundReport?.llmProvider ?? job?.llmProvider ?? llmProvider;
  const resolvedModel = boundReport?.llmModel ?? job?.llmModel ?? llmModel;
  const modelDisplay =
    resolvedProvider && resolvedProvider !== "none"
      ? `${resolvedProvider} · ${resolvedModel || "default"}`
      : "未配置";

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

  if (!job) {
    return <EmptyState title="请选择一个审查运行以查看其报告。" />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {binding.status === "mismatch" && (
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger-faint)",
            borderRadius: "var(--ds-radius-md)",
            color: "var(--danger-strong)",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "13px"
          }}
        >
          <ShieldAlert size={18} />
          <span>
            <strong>{zh ? "报告完整性校验未通过:" : "Report integrity check failed."}</strong>{" "}
            {zh ? "该报告与选定的审查任务不匹配，已拒绝展示。" : "The report does not belong to the selected job."}
          </span>
        </div>
      )}

      {/* Review Hero Header */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-lg)",
          padding: "20px 24px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <Badge variant="neutral" size="sm" mono>
                REVIEW RUN
              </Badge>
              <span style={{ fontSize: "12px", color: "var(--muted)", fontWeight: 500 }}>
                {job.repositoryFullName}
              </span>
            </div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>
              {job.pullRequestNumber === undefined
                ? "本地工作区代码审查"
                : `PR #${job.pullRequestNumber} 审查报告`}
            </h2>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "var(--foreground)" }}>
                {boundReport?.score ?? "-"}
              </div>
              <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase" }}>
                质量评分
              </div>
            </div>
            {boundReport && (
              <Badge
                variant={
                  boundReport.riskLevel === "critical" || boundReport.riskLevel === "high"
                    ? "danger"
                    : boundReport.riskLevel === "medium"
                    ? "warning"
                    : "success"
                }
                size="md"
              >
                {boundReport.riskLevel.toUpperCase()}
              </Badge>
            )}
          </div>
        </div>

        {/* Metadata Strip */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            padding: "12px 16px",
            background: "var(--surface-subtle)",
            borderRadius: "var(--ds-radius-md)",
            border: "1px solid var(--border-subtle)",
            fontSize: "12px",
            marginBottom: "16px"
          }}
        >
          <div>
            <span style={{ color: "var(--muted)", marginRight: "6px" }}>代码范围:</span>
            <code style={{ fontFamily: "var(--ds-font-mono)" }}>
              {job.baseSha.substring(0, 7)} → {job.headSha.substring(0, 7)}
            </code>
          </div>

          <div>
            <span style={{ color: "var(--muted)", marginRight: "6px" }}>审查状态:</span>
            <Badge variant={job.status === "succeeded" ? "success" : job.status === "running" ? "warning" : "neutral"} size="sm">
              {job.status.toUpperCase()}
            </Badge>
          </div>

          <div>
            <span style={{ color: "var(--muted)", marginRight: "6px" }}>发现问题:</span>
            <strong>{boundReport?.findings.length ?? 0} 项</strong>
          </div>

          <div>
            <span style={{ color: "var(--muted)", marginRight: "6px" }}>执行模型:</span>
            <span style={{ fontFamily: "var(--ds-font-mono)" }}>{modelDisplay}</span>
          </div>

          <div>
            <span style={{ color: "var(--muted)", marginRight: "6px" }}>来源模式:</span>
            <span>{provenance.sourceText}</span>
          </div>

          <div>
            <span style={{ color: "var(--muted)", marginRight: "6px" }}>发布模式:</span>
            <span>{provenance.publicationText}</span>
          </div>
        </div>

        {/* Summary Description */}
        <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.6, color: "var(--foreground)" }}>
          {boundReport?.summary ?? job.error ?? (zh ? "审查正在执行中..." : "Review is in progress.")}
        </p>
      </section>

      {/* Main Content Layout: Findings on left, Decision/Evidence on right */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: "20px" }}>
        {/* Left: Findings */}
        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--ds-radius-md)",
            padding: "16px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>审查发现 (Findings)</h3>
              <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
                已核验的事实证据、推导与修复建议
              </p>
            </div>

            <div style={{ display: "flex", gap: "4px" }}>
              <Button
                variant={groupBy === "severity" ? "primary" : "secondary"}
                size="sm"
                onClick={() => setGroupBy("severity")}
              >
                按严重度
              </Button>
              <Button
                variant={groupBy === "agent" ? "primary" : "secondary"}
                size="sm"
                onClick={() => setGroupBy("agent")}
              >
                按智能体
              </Button>
            </div>
          </div>

          <div>
            {!boundReport ? (
              <EmptyState compact title="审查执行中" description="审查完成后将展示分析发现与缺陷建议。" />
            ) : groups.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "16px",
                  background: "var(--success-soft)",
                  color: "var(--success-strong)",
                  borderRadius: "var(--ds-radius-md)",
                  fontSize: "13px"
                }}
              >
                <CheckCircle2 size={18} />
                <span>本次审查未发现代码缺陷与安全违规。</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {groups.map(([group, findings]) => (
                  <div key={group}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 600 }}>
                        {zh
                          ? group === "critical"
                            ? "严重缺陷 (Critical)"
                            : group === "high"
                            ? "高危问题 (High)"
                            : group === "medium"
                            ? "中等风险 (Medium)"
                            : group === "low"
                            ? "低危建议 (Low)"
                            : group
                          : group}
                      </span>
                      <Badge variant="neutral" size="sm">
                        {findings.length}
                      </Badge>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {findings.map(finding => (
                        <FindingItem key={finding.id} finding={finding} onLocate={() => undefined} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Right: Decision & Evidence summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Recommendation summary card */}
          {boundReport && (
            <section
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                padding: "16px"
              }}
            >
              <SectionHeader
                title={zh ? "综合判定与处置建议 (Decision)" : "Decision"}
                actions={
                  <Badge
                    variant={
                      boundReport.riskLevel === "critical" || boundReport.riskLevel === "high"
                        ? "danger"
                        : "success"
                    }
                    size="sm"
                  >
                    {boundReport.riskLevel.toUpperCase()}
                  </Badge>
                }
              />
              <p style={{ margin: "0 0 12px 0", fontSize: "13px", lineHeight: 1.5 }}>
                {boundReport.summary}
              </p>
              {boundReport.findings.length > 0 && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--surface-subtle)",
                    borderRadius: "var(--ds-radius-sm)",
                    fontSize: "12px",
                    borderLeft: "3px solid var(--primary)"
                  }}
                >
                  <div style={{ fontWeight: 600, color: "var(--foreground)", marginBottom: "2px" }}>
                    首要整改建议:
                  </div>
                  <div style={{ color: "var(--muted-strong)" }}>
                    {boundReport.findings[0]?.recommendation}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Evidence Quick Summary card */}
          {boundReport?.retrieval && (
            <section
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                padding: "16px"
              }}
            >
              <SectionHeader
                title="证据链检索摘要"
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/runs/${encodeURIComponent(job.id)}/evidence`)}
                  >
                    查看完整证据
                  </Button>
                }
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--muted)" }}>上下文预算:</span>
                  <strong>{boundReport.retrieval.context_budget_tokens.toLocaleString()} tokens</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--muted)" }}>平均压缩率:</span>
                  <strong>{Math.round((boundReport.retrieval.summary.average_compression_ratio ?? 0) * 100)}%</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--muted)" }}>证据覆盖文件:</span>
                  <strong>{boundReport.retrieval.summary.files_with_evidence} 个</strong>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
