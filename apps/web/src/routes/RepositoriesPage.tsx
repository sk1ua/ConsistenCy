import React, { useState, useMemo } from "react";
import type { HeartbeatPulse, Repository, ReviewJob } from "@consistency/schema";
import {
  FolderGit2,
  Plus,
  Search,
  Github,
  GitBranch,
  ShieldCheck,
  Activity,
  PlayCircle,
  Eye,
  Radio
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../design-system/Button";
import { Input } from "../design-system/Input";
import { Badge } from "../design-system/Badge";
import { DataTable, type Column } from "../design-system/DataTable";
import { EmptyState } from "../design-system/EmptyState";
import { SectionHeader } from "../design-system/SectionHeader";
import { AppLink } from "../design-system/Link";
import { ConnectRepositoryDialog } from "../components/ConnectRepositoryDialog";

export interface RepositoriesPageProps {
  jobs: ReviewJob[];
  pulse: HeartbeatPulse | null;
  heartbeatUnavailable?: boolean;
  jobsUnavailable?: boolean;
  repositories?: Repository[];
  registryUnavailable?: boolean;
  canSelectRepository?: boolean;
  addingRepository?: boolean;
  addRepositoryError?: string;
  monitoringError?: string;
  onAddRepository?: () => void;
  monitoringRepositoryId?: string;
  onSetMonitoring?: (repository: Repository, enabled: boolean) => void;
}

export const RepositoriesPage: React.FC<RepositoriesPageProps> = ({
  jobs,
  pulse,
  repositories = [],
  registryUnavailable = false,
  canSelectRepository = false,
  addingRepository = false,
  onAddRepository,
  monitoringRepositoryId,
  onSetMonitoring
}) => {
  const [query, setQuery] = useState("");
  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    return repositories.filter(
      r =>
        r.displayName.toLowerCase().includes(query.toLowerCase()) ||
        r.id.toLowerCase().includes(query.toLowerCase()) ||
        r.remoteFullName?.toLowerCase().includes(query.toLowerCase())
    );
  }, [repositories, query]);

  const columns: Column<Repository>[] = [
    {
      key: "displayName",
      header: "代码仓库",
      render: repo => (
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "var(--primary)" }}>
            {repo.source === "github" ? <Github size={16} /> : <FolderGit2 size={16} />}
          </span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <AppLink
              to={`/repositories/${encodeURIComponent(repo.id)}/overview`}
              style={{ fontWeight: 600, fontSize: "13px" }}
            >
              {repo.displayName}
            </AppLink>
            {repo.remoteFullName && (
              <span style={{ fontSize: "11px", color: "var(--muted)" }}>
                {repo.remoteFullName}
              </span>
            )}
          </div>
        </div>
      )
    },
    {
      key: "source",
      header: "来源类型",
      render: repo => (
        <Badge variant="neutral" size="sm" mono>
          {repo.source === "local_git" ? "Local Git" : "GitHub"}
        </Badge>
      )
    },
    {
      key: "trustLevel",
      header: "执行信任",
      render: repo => (
        <Badge variant={repo.trustLevel === "trusted_local" ? "success" : "neutral"} size="sm">
          {repo.trustLevel === "trusted_local" ? "trusted local" : "untrusted readonly"}
        </Badge>
      )
    },
    {
      key: "status",
      header: "工作区状态",
      render: repo => {
        const matchingJobCount = jobs.filter(j =>
          j.repositoryFullName === repo.displayName ||
          j.repositoryFullName === repo.id ||
          (repo.remoteFullName && j.repositoryFullName === repo.remoteFullName)
        ).length;
        const isPulseRepo = pulse?.repository.root && (pulse.repository.root.includes(repo.displayName) || repo.displayName === "ConsistenCy");

        return (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
            {isPulseRepo && pulse ? (
              <span style={{ display: "flex", alignItems: "center", gap: "4px", color: "var(--success-strong)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }} />
                <span>活跃监控中 ({pulse.dirtyFileCount} 变更)</span>
              </span>
            ) : (
              <span style={{ color: "var(--muted)" }}>{matchingJobCount} 次审查记录</span>
            )}
          </div>
        );
      }
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: repo => (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/repositories/${encodeURIComponent(repo.id)}/overview`)}
          >
            打开工作区
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<PlayCircle size={13} />}
            onClick={() => navigate(`/repositories/${encodeURIComponent(repo.id)}/overview?composer=open`)}
          >
            开始审查
          </Button>
        </div>
      )
    }
  ];

  return (
    <div style={{ padding: "24px 32px", maxWidth: "1200px", margin: "0 auto" }}>
      <SectionHeader
        title="代码仓库工作区 (Repositories)"
        subtitle="已连接的本地 Git 项目和远程 GitHub 代码审查源"
        actions={
          <Button
            variant="primary"
            size="md"
            icon={<Plus size={14} />}
            onClick={() => {
              if (onAddRepository && canSelectRepository) {
                onAddRepository();
              } else {
                setIsConnectOpen(true);
              }
            }}
          >
            连接代码仓库
          </Button>
        }
      />

      <div style={{ marginBottom: "16px", maxWidth: "320px" }}>
        <Input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索已连接仓库..."
          prefixIcon={<Search size={14} />}
          sizeVariant="sm"
        />
      </div>

      {filtered.length === 0 && !registryUnavailable ? (
        <EmptyState
          icon={<FolderGit2 size={36} />}
          title="暂无已连接的代码仓库"
          description="点击“连接代码仓库”选择本地 Git 工作区或输入 GitHub 仓库以开始深度审查。"
          action={
            <Button
              variant="primary"
              size="md"
              icon={<Plus size={14} />}
              onClick={() => setIsConnectOpen(true)}
            >
              立即连接仓库
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyExtractor={repo => repo.id}
          onRowClick={repo => navigate(`/repositories/${encodeURIComponent(repo.id)}/overview`)}
        />
      )}

      <ConnectRepositoryDialog
        isOpen={isConnectOpen}
        onClose={() => setIsConnectOpen(false)}
        onSuccess={repo => {
          if (repo?.id) {
            navigate(`/repositories/${encodeURIComponent(repo.id)}/overview`);
          }
        }}
      />
    </div>
  );
};
