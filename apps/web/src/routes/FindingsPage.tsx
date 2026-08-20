import React, { useState, useMemo } from "react";
import type { ReviewReport, Severity, ReviewFinding } from "@consistency/schema";
import { ShieldAlert, Search, FileCode2, ExternalLink, Filter } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Input } from "../design-system/Input";
import { Select } from "../design-system/Select";
import { Badge } from "../design-system/Badge";
import { Button } from "../design-system/Button";
import { DataTable, type Column } from "../design-system/DataTable";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";
import { AppLink } from "../design-system/Link";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};

export interface FindingsPageProps {
  reports: ReviewReport[];
  reportsUnavailable?: boolean;
}

interface FindingRow {
  finding: ReviewFinding;
  report: ReviewReport;
}

export const FindingsPage: React.FC<FindingsPageProps> = ({ reports, reportsUnavailable = false }) => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const allFindings = useMemo<FindingRow[]>(() => {
    return reports
      .flatMap(report => report.findings.map(finding => ({ finding, report })))
      .sort(
        (left, right) =>
          (SEVERITY_ORDER[right.finding.severity] ?? 0) -
          (SEVERITY_ORDER[left.finding.severity] ?? 0)
      );
  }, [reports]);

  const filtered = useMemo(() => {
    return allFindings.filter(({ finding, report }) => {
      const matchSeverity = severityFilter === "all" || finding.severity === severityFilter;
      const matchSearch =
        !search.trim() ||
        finding.title.toLowerCase().includes(search.toLowerCase()) ||
        finding.file.toLowerCase().includes(search.toLowerCase()) ||
        report.repositoryFullName.toLowerCase().includes(search.toLowerCase()) ||
        finding.agent.toLowerCase().includes(search.toLowerCase());
      return matchSeverity && matchSearch;
    });
  }, [allFindings, search, severityFilter]);

  const columns: Column<FindingRow>[] = [
    {
      key: "severity",
      header: "严重度",
      width: 100,
      render: ({ finding }) => (
        <Badge
          variant={
            finding.severity === "critical" || finding.severity === "high"
              ? "danger"
              : finding.severity === "medium"
              ? "warning"
              : "neutral"
          }
          size="sm"
        >
          {finding.severity.toUpperCase()}
        </Badge>
      )
    },
    {
      key: "title",
      header: "缺陷与建议",
      render: ({ finding }) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600, fontSize: "13px" }}>{finding.title}</span>
          <span
            style={{
              fontSize: "12px",
              color: "var(--muted)",
              fontFamily: "var(--ds-font-mono)",
              marginTop: "2px"
            }}
          >
            {finding.file}
            {finding.startLine !== undefined ? `:${finding.startLine}` : ""}
          </span>
        </div>
      )
    },
    {
      key: "agent",
      header: "发现智能体",
      width: 140,
      render: ({ finding }) => (
        <Badge variant="neutral" size="sm">
          {finding.agent}
        </Badge>
      )
    },
    {
      key: "confidence",
      header: "可信度",
      width: 110,
      render: ({ finding }) => (
        <Badge variant={finding.confidence === "confirmed" ? "success" : "neutral"} size="sm">
          {finding.confidence}
        </Badge>
      )
    },
    {
      key: "repository",
      header: "所属代码仓库",
      width: 180,
      render: ({ report }) => (
        <AppLink
          to={`/repositories/${encodeURIComponent(report.repositoryFullName)}/overview`}
          style={{ fontSize: "12px", fontWeight: 500 }}
        >
          {report.repositoryFullName}
        </AppLink>
      )
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      width: 100,
      render: ({ report }) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/runs/${encodeURIComponent(report.jobId)}/overview`)}
        >
          查看报告
        </Button>
      )
    }
  ];

  return (
    <div style={{ padding: "24px 32px", maxWidth: "1280px", margin: "0 auto" }}>
      <SectionHeader
        title="审查发现索引 (Findings Index)"
        subtitle="跨所有代码仓库与审查聚合的静态及语义分析事实证据"
      />

      {/* Filters */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ width: "280px" }}>
          <Input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索缺陷、文件或仓库..."
            prefixIcon={<Search size={14} />}
            sizeVariant="sm"
          />
        </div>

        <Select
          sizeVariant="sm"
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value)}
          options={[
            { label: "全部严重度 (All Severities)", value: "all" },
            { label: "严重 (Critical)", value: "critical" },
            { label: "高危 (High)", value: "high" },
            { label: "中危 (Medium)", value: "medium" },
            { label: "低危 (Low)", value: "low" }
          ]}
        />

        <div style={{ marginLeft: "auto", fontSize: "12px", color: "var(--muted)" }}>
          共 <strong>{filtered.length}</strong> 项发现
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert size={36} />}
          title="未找到匹配的审查发现"
          description="请尝试调整严重度筛选或搜索条件。"
        />
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyExtractor={({ finding, report }) => `${report.jobId}-${finding.id}`}
          onRowClick={({ report }) => navigate(`/runs/${encodeURIComponent(report.jobId)}/overview`)}
        />
      )}
    </div>
  );
};
