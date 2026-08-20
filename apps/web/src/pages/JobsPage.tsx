import React, { useMemo, useState } from "react";
import type { JobStatus, ReviewJob, Severity } from "@consistency/schema";
import { PlayCircle, Search, Filter, ShieldCheck, ShieldAlert, Clock, GitBranch } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { DataTable, type Column } from "../design-system/DataTable";
import { Input } from "../design-system/Input";
import { Select } from "../design-system/Select";
import { Badge } from "../design-system/Badge";
import { Button } from "../design-system/Button";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";
import { AppLink } from "../design-system/Link";
import { useI18n } from "../i18n";

export interface JobsPageProps {
  jobs: ReviewJob[];
  onOpenJob?: (job: ReviewJob) => void;
}

export const JobsPage: React.FC<JobsPageProps> = ({ jobs, onOpenJob }) => {
  const { t } = useI18n();
  let navigate: (path: string) => void = () => {};
  try {
    navigate = useNavigate();
  } catch {
    navigate = () => {};
  }
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<JobStatus | "">("");
  const [severity, setSeverity] = useState<Severity | "">("");

  const filtered = useMemo(() => {
    return jobs.filter(job => {
      if (
        search &&
        !`${job.repositoryFullName} ${job.pullRequestNumber || ""} ${job.id}`
          .toLowerCase()
          .includes(search.toLowerCase())
      ) {
        return false;
      }
      if (status && job.status !== status) return false;
      if (severity && !job.report?.findings.some(f => f.severity === severity)) return false;
      return true;
    });
  }, [jobs, search, status, severity]);

  const columns: Column<ReviewJob>[] = [
    {
      key: "id",
      header: "审查 ID",
      width: 110,
      render: job => (
        <AppLink
          to={`/runs/${encodeURIComponent(job.id)}/overview`}
          style={{ fontFamily: "var(--ds-font-mono)", fontWeight: 600 }}
        >
          {job.id.substring(0, 8)}
        </AppLink>
      )
    },
    {
      key: "repository",
      header: "目标仓库 / 来源",
      render: job => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600, fontSize: "13px" }}>{job.repositoryFullName}</span>
          <span style={{ fontSize: "11px", color: "var(--muted)" }}>
            {job.pullRequestNumber !== undefined
              ? `PR #${job.pullRequestNumber}`
              : "本地工作区 (Local Git)"}
          </span>
        </div>
      )
    },
    {
      key: "status",
      header: "执行状态",
      width: 110,
      render: job => (
        <Badge
          variant={
            job.status === "succeeded"
              ? "success"
              : job.status === "running"
              ? "warning"
              : job.status === "failed"
              ? "danger"
              : "neutral"
          }
          size="sm"
          dot={job.status === "running"}
        >
          {job.status.toUpperCase()}
        </Badge>
      )
    },
    {
      key: "score",
      header: "质量得分",
      width: 100,
      render: job => {
        if (job.report?.score !== undefined) {
          return (
            <Badge
              variant={
                job.report.riskLevel === "critical" || job.report.riskLevel === "high"
                  ? "danger"
                  : job.report.riskLevel === "medium"
                  ? "warning"
                  : "success"
              }
              size="sm"
            >
              {job.report.score} 分
            </Badge>
          );
        }
        return <span style={{ color: "var(--muted)" }}>—</span>;
      }
    },
    {
      key: "findings",
      header: "缺陷发现",
      width: 100,
      render: job => (
        <span>
          {job.report ? (
            <strong>{job.report.findings.length} 项</strong>
          ) : (
            <span style={{ color: "var(--muted)" }}>—</span>
          )}
        </span>
      )
    },
    {
      key: "model",
      header: "执行模型",
      width: 180,
      render: job => (
        <span style={{ fontSize: "12px", fontFamily: "var(--ds-font-mono)" }}>
          {job.llmProvider || "deepseek"} · {job.llmModel || "deepseek-v4-flash"}
        </span>
      )
    },
    {
      key: "createdAt",
      header: "审查时间",
      width: 160,
      render: job => (
        <span style={{ fontSize: "12px", color: "var(--muted)" }}>
          {new Date(job.createdAt).toLocaleString()}
        </span>
      )
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      width: 100,
      render: job => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (onOpenJob) onOpenJob(job);
            else navigate(`/runs/${encodeURIComponent(job.id)}/overview`);
          }}
        >
          查看
        </Button>
      )
    }
  ];

  return (
    <div style={{ padding: "24px 32px", maxWidth: "1280px", margin: "0 auto" }}>
      <SectionHeader
        title="代码审查运行记录 (Review Runs)"
        subtitle="已触发并持久化的可复现证据审查任务列表"
      />

      {/* Filter bar */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ width: "280px" }}>
          <Input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t("Search repository or PR")}
            prefixIcon={<Search size={14} />}
            sizeVariant="sm"
          />
        </div>

        <Select
          sizeVariant="sm"
          value={status}
          onChange={e => setStatus(e.target.value as any)}
          options={[
            { label: "全部状态 (All Statuses)", value: "" },
            { label: "排队中 (Queued)", value: "queued" },
            { label: "执行中 (Running)", value: "running" },
            { label: "已完成 (Succeeded)", value: "succeeded" },
            { label: "失败 (Failed)", value: "failed" }
          ]}
        />

        <Select
          sizeVariant="sm"
          value={severity}
          onChange={e => setSeverity(e.target.value as any)}
          options={[
            { label: "全部缺陷严重度", value: "" },
            { label: "严重 (Critical)", value: "critical" },
            { label: "高危 (High)", value: "high" },
            { label: "中危 (Medium)", value: "medium" },
            { label: "低危 (Low)", value: "low" }
          ]}
        />

        <div style={{ marginLeft: "auto", fontSize: "12px", color: "var(--muted)" }}>
          共 <strong>{filtered.length}</strong> 条审查记录
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<PlayCircle size={36} />}
          title="未找到匹配的审查运行记录"
          description="请尝试调整筛选条件或搜索关键词。"
        />
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyExtractor={j => j.id}
          onRowClick={j => {
            if (onOpenJob) onOpenJob(j);
            else navigate(`/runs/${encodeURIComponent(j.id)}/overview`);
          }}
        />
      )}
    </div>
  );
};
