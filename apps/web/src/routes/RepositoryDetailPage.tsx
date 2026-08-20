import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import type {
  Automation,
  HeartbeatPulse,
  Repository,
  ReviewJob,
  VcsCommitSummary,
  PullRequestSummary
} from "@consistency/schema";
import {
  FolderGit2,
  GitBranch,
  GitCommit,
  GitPullRequest,
  PlayCircle,
  FileCode2,
  History,
  ShieldAlert,
  ShieldCheck,
  Activity,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Plus,
  Clock,
  Sparkles,
  FileDiff
} from "lucide-react";
import { api, type HealthResponse } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Button } from "../design-system/Button";
import { Badge } from "../design-system/Badge";
import { Tabs } from "../design-system/Tabs";
import { DataTable, type Column } from "../design-system/DataTable";
import { EmptyState } from "../design-system/EmptyState";
import { SectionHeader } from "../design-system/SectionHeader";
import { AppLink } from "../design-system/Link";
import { ReviewComposerDialog } from "../components/ReviewComposerDialog";

export interface RepositoryDetailPageProps {
  jobs: ReviewJob[];
  repositories: Repository[];
  automations?: Automation[];
  pulse?: HeartbeatPulse | null;
  health?: HealthResponse;
}

export const RepositoryDetailPage: React.FC<RepositoryDetailPageProps> = ({
  jobs,
  repositories,
  pulse,
  health
}) => {
  const { repositoryId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [isComposerOpen, setIsComposerOpen] = useState(() => {
    return new URLSearchParams(location.search).get("composer") === "open";
  });
  const [selectedCommit, setSelectedCommit] = useState<VcsCommitSummary | null>(null);

  // Derive active tab from URL path
  const activeTab = useMemo(() => {
    if (location.pathname.includes("/changes")) return "changes";
    if (location.pathname.includes("/history")) return "history";
    if (location.pathname.includes("/pull-requests")) return "pull-requests";
    if (location.pathname.includes("/reviews")) return "reviews";
    if (location.pathname.includes("/workflows")) return "workflows";
    return "overview";
  }, [location.pathname]);

  const handleTabChange = (tabId: string) => {
    navigate(`/repositories/${encodeURIComponent(repositoryId)}/${tabId}`);
  };

  // Queries for repository git status, commits, PRs, review preparation
  const gitStatusQuery = useQuery({
    queryKey: ["repository-git-status", repositoryId],
    queryFn: () => api.repositoryGitStatus(repositoryId),
    refetchInterval: 10_000
  });

  const commitsQuery = useQuery({
    queryKey: ["repository-commits", repositoryId],
    queryFn: () => api.repositoryCommits(repositoryId, 30)
  });

  const prsQuery = useQuery({
    queryKey: ["repository-prs", repositoryId],
    queryFn: () => api.repositoryPullRequests(repositoryId)
  });

  const prepQuery = useQuery({
    queryKey: ["review-preparation", repositoryId],
    queryFn: () => api.reviewPreparation(repositoryId),
    refetchInterval: 15_000
  });

  // Find repository model
  const repo = useMemo(() => {
    return (
      repositories.find(r => r.id === repositoryId || r.displayName === repositoryId) ?? {
        id: repositoryId,
        displayName: repositoryId.replace(/^local:/, ""),
        source: "local_git" as const,
        trustLevel: "trusted_local" as const,
        monitoringEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    );
  }, [repositories, repositoryId]);

  // Repository-specific review jobs
  const repoJobs = useMemo(() => {
    return jobs.filter(
      j =>
        j.repositoryFullName === repositoryId ||
        j.repositoryFullName === repo.displayName ||
        (repo.remoteFullName && j.repositoryFullName === repo.remoteFullName) ||
        repositoryId.includes(j.repositoryFullName) ||
        j.repositoryFullName.includes(repo.displayName)
    );
  }, [jobs, repositoryId, repo.displayName, repo.remoteFullName]);

  const displayPRs = useMemo<PullRequestSummary[]>(() => {
    const apiPrs = prsQuery.data?.pullRequests ?? [];
    if (apiPrs.length > 0) return apiPrs;

    return repoJobs
      .filter(j => j.pullRequestNumber !== undefined)
      .map(j => ({
        number: j.pullRequestNumber!,
        title: `PR #${j.pullRequestNumber}`,
        state: "open" as const,
        author: "contributor",
        baseRef: "main",
        headRef: `pr-${j.pullRequestNumber}`,
        baseSha: j.baseSha,
        headSha: j.headSha,
        createdAt: j.createdAt,
        updatedAt: j.createdAt,
        score: j.report?.score,
        riskLevel: j.report?.riskLevel,
        jobId: j.id
      }));
  }, [prsQuery.data?.pullRequests, repoJobs]);

  const [prFilter, setPrFilter] = useState<"all" | "open" | "merged" | "closed">("all");

  const filteredPRs = useMemo(() => {
    if (prFilter === "all") return displayPRs;
    return displayPRs.filter(pr => pr.state === prFilter);
  }, [displayPRs, prFilter]);

  const tabs = [
    { id: "overview", label: "概览" },
    {
      id: "changes",
      label: "变更",
      count: gitStatusQuery.data?.dirtyFileCount || undefined
    },
    { id: "history", label: "提交历史" },
    {
      id: "pull-requests",
      label: "拉取请求",
      count: displayPRs.length || undefined
    },
    { id: "reviews", label: "审查", count: repoJobs.length || undefined },
    { id: "workflows", label: "工作流" }
  ];

  // Commit columns
  const commitColumns: Column<VcsCommitSummary>[] = [
    {
      key: "sha",
      header: "SHA",
      width: 100,
      render: c => (
        <Badge variant="neutral" size="sm" mono>
          {c.sha.substring(0, 7)}
        </Badge>
      )
    },
    {
      key: "message",
      header: "提交说明",
      render: c => (
        <span style={{ fontWeight: 500, fontSize: "13px" }}>{c.message}</span>
      )
    },
    {
      key: "author",
      header: "作者",
      width: 160,
      render: c => (
        <span style={{ color: "var(--muted-strong)", fontSize: "12px" }}>{c.author.name}</span>
      )
    },
    {
      key: "authoredAt",
      header: "提交时间",
      width: 160,
      render: c => (
        <span style={{ color: "var(--muted)", fontSize: "12px" }}>
          {new Date(c.authoredAt).toLocaleString()}
        </span>
      )
    }
  ];

  // PR columns
  const prColumns: Column<PullRequestSummary>[] = [
    {
      key: "number",
      header: "#",
      width: 60,
      render: pr => (
        <span style={{ fontFamily: "var(--ds-font-mono)", fontWeight: 600 }}>#{pr.number}</span>
      )
    },
    {
      key: "title",
      header: "PR 标题",
      render: pr => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600 }}>{pr.title}</span>
          <span style={{ fontSize: "11px", color: "var(--muted)" }}>
            {pr.headRef} → {pr.baseRef} · 由 {pr.author} 提交
          </span>
        </div>
      )
    },
    {
      key: "state",
      header: "状态",
      width: 90,
      render: pr => (
        <Badge variant={pr.state === "open" ? "success" : "neutral"} size="sm">
          {pr.state.toUpperCase()}
        </Badge>
      )
    },
    {
      key: "reviewStatus",
      header: "审查结果",
      width: 120,
      render: pr => {
        if (pr.score !== undefined) {
          return (
            <Badge variant={pr.riskLevel === "critical" || pr.riskLevel === "high" ? "danger" : "success"} size="sm">
              得分 {pr.score}
            </Badge>
          );
        }
        return <span style={{ color: "var(--muted)", fontSize: "12px" }}>未审查</span>;
      }
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      width: 120,
      render: pr => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (pr.jobId) {
              navigate(`/runs/${encodeURIComponent(pr.jobId)}/overview`);
            } else {
              setIsComposerOpen(true);
            }
          }}
        >
          {pr.jobId ? "查看报告" : "发起审查"}
        </Button>
      )
    }
  ];

  // Review Job columns
  const reviewColumns: Column<ReviewJob>[] = [
    {
      key: "id",
      header: "审查 ID",
      width: 110,
      render: job => (
        <AppLink to={`/runs/${encodeURIComponent(job.id)}/overview`} style={{ fontFamily: "var(--ds-font-mono)", fontWeight: 600 }}>
          {job.id.substring(0, 8)}
        </AppLink>
      )
    },
    {
      key: "target",
      header: "审查目标",
      render: job => (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span>{job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : "工作区变更"}</span>
          <Badge variant="neutral" size="sm" mono>
            {job.headSha.substring(0, 7)}
          </Badge>
        </div>
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
      key: "status",
      header: "状态 / 评分",
      width: 140,
      render: job => {
        if (job.status === "succeeded" && job.report) {
          return (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Badge variant="success" size="sm">
                成功
              </Badge>
              <Badge variant={job.report.riskLevel === "critical" || job.report.riskLevel === "high" ? "danger" : "primary"} size="sm">
                {job.report.score} 分
              </Badge>
            </div>
          );
        }
        if (job.status === "running") {
          return <Badge variant="warning" size="sm" dot>执行中</Badge>;
        }
        if (job.status === "failed") {
          return <Badge variant="danger" size="sm">失败</Badge>;
        }
        return <Badge variant="neutral" size="sm">已排队</Badge>;
      }
    },
    {
      key: "createdAt",
      header: "时间",
      width: 150,
      render: job => (
        <span style={{ fontSize: "12px", color: "var(--muted)" }}>
          {new Date(job.createdAt).toLocaleString()}
        </span>
      )
    }
  ];

  const gitStatus = gitStatusQuery.data;
  const prep = prepQuery.data;

  return (
    <div style={{ padding: "20px 28px", maxWidth: "1280px", margin: "0 auto" }}>
      {/* Workspace Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
          paddingBottom: "16px",
          borderBottom: "1px solid var(--border)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "var(--ds-radius-md)",
              background: "var(--primary-soft)",
              color: "var(--primary-strong)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            <FolderGit2 size={20} />
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>{repo.displayName}</h1>
              <Badge variant="neutral" size="sm" mono>
                {repo.source === "local_git" ? "本地 Git" : "GitHub"}
              </Badge>
              <Badge variant={repo.trustLevel === "trusted_local" ? "success" : "neutral"} size="sm">
                {repo.trustLevel === "trusted_local" ? "Trusted Local" : "Read-only"}
              </Badge>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <GitBranch size={12} />
                <span>{gitStatus?.branch || "main"}</span>
              </span>
              {gitStatus?.headSha && (
                <span style={{ display: "flex", alignItems: "center", gap: "4px", fontFamily: "var(--ds-font-mono)" }}>
                  <GitCommit size={12} />
                  <span>{gitStatus.headSha.substring(0, 7)}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Button
            variant="primary"
            size="md"
            icon={<PlayCircle size={15} />}
            onClick={() => setIsComposerOpen(true)}
          >
            审查代码
          </Button>
        </div>
      </div>

      {/* Workspace Tabs Navigation */}
      <div style={{ marginBottom: "20px" }}>
        <Tabs tabs={tabs} activeId={activeTab} onChange={handleTabChange} />
      </div>

      {/* Tab View 1: Overview */}
      {activeTab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Review Readiness Banner */}
          <div
            style={{
              padding: "16px 20px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--ds-radius-lg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: prep?.canStartReview ? "var(--success-soft)" : "var(--warning-soft)",
                  color: prep?.canStartReview ? "var(--success-strong)" : "var(--warning-strong)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                {prep?.canStartReview ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>
                  {prep?.canStartReview ? "审查就绪 (Ready for Review)" : "当前审查不可用"}
                </div>
                <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
                  {prep?.sources.workingTree.available
                    ? `检测到工作区有 ${prep.sources.workingTree.changedFileCount} 个未提交变更文件，可立即执行审查。`
                    : prep?.sources.branch.available
                    ? `检测到分支 ${prep.sources.branch.head} 与基准分支差异，可执行分支对比审查。`
                    : "工作区当前干净，无未提交变更。"}
                </div>
              </div>
            </div>

            <Button
              variant={prep?.canStartReview ? "primary" : "outline"}
              size="sm"
              icon={<PlayCircle size={14} />}
              onClick={() => setIsComposerOpen(true)}
            >
              配置并审查
            </Button>
          </div>

          {/* Two-column layout for Recent Reviews and Recent Commits */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
            {/* Recent Reviews Summary */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                padding: "16px"
              }}
            >
              <SectionHeader
                title="最近审查记录"
                actions={
                  repoJobs.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => handleTabChange("reviews")}>
                      查看全部 →
                    </Button>
                  )
                }
              />
              {repoJobs.length === 0 ? (
                <EmptyState
                  compact
                  title="暂无审查记录"
                  description="点击“开始审查”按钮发起首次代码质量与安全性审查。"
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {repoJobs.slice(0, 4).map(job => (
                    <div
                      key={job.id}
                      onClick={() => navigate(`/runs/${encodeURIComponent(job.id)}/overview`)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 10px",
                        borderRadius: "var(--ds-radius-sm)",
                        background: "var(--surface-subtle)",
                        cursor: "pointer",
                        border: "1px solid var(--border-subtle)"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Badge variant="neutral" size="sm" mono>
                          {job.id.substring(0, 8)}
                        </Badge>
                        <span style={{ fontSize: "13px", fontWeight: 500 }}>
                          {job.pullRequestNumber ? `PR #${job.pullRequestNumber}` : "工作区审查"}
                        </span>
                      </div>
                      {job.report?.score !== undefined && (
                        <Badge variant={job.report.riskLevel === "critical" || job.report.riskLevel === "high" ? "danger" : "success"} size="sm">
                          {job.report.score} 分
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Commits Summary */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                padding: "16px"
              }}
            >
              <SectionHeader
                title="最近代码提交"
                actions={
                  (commitsQuery.data?.commits.length || 0) > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => handleTabChange("history")}>
                      查看全部 →
                    </Button>
                  )
                }
              />
              {commitsQuery.isLoading ? (
                <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)" }}>
                  正在读取 Git 提交历史...
                </div>
              ) : (commitsQuery.data?.commits.length || 0) === 0 ? (
                <EmptyState compact title="暂无提交历史" description="本地 Git 历史为空或不可读。" />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {commitsQuery.data!.commits.slice(0, 4).map(c => (
                    <div
                      key={c.sha}
                      onClick={() => handleTabChange("history")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 10px",
                        borderRadius: "var(--ds-radius-sm)",
                        background: "var(--surface-subtle)",
                        cursor: "pointer",
                        border: "1px solid var(--border-subtle)"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                        <Badge variant="neutral" size="sm" mono>
                          {c.sha.substring(0, 7)}
                        </Badge>
                        <span style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.message}
                        </span>
                      </div>
                      <span style={{ fontSize: "11px", color: "var(--muted)", flexShrink: 0 }}>
                        {c.author.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab View 2: Changes */}
      {activeTab === "changes" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title="工作区代码变更 (Working Tree Changes)"
            subtitle={`当前检测到 ${gitStatus?.dirtyFileCount || 0} 个未提交变更文件`}
            actions={
              <Button
                variant="primary"
                size="sm"
                icon={<PlayCircle size={14} />}
                disabled={!gitStatus?.dirtyFileCount}
                onClick={() => setIsComposerOpen(true)}
              >
                审查工作区变更
              </Button>
            }
          />

          {!gitStatus?.dirtyFileCount ? (
            <EmptyState
              icon={<CheckCircle2 size={36} color="var(--success)" />}
              title="工作区干净，无未提交变更"
              description="所有代码均已提交到本地 Git 仓库。您可以切换到“提交历史”或“Pull Requests”进行审查。"
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {gitStatus.changedFiles.map(f => (
                <div
                  key={f.path}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--ds-radius-md)",
                    padding: "12px 16px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <FileDiff size={16} style={{ color: "var(--primary)" }} />
                    <span style={{ fontFamily: "var(--ds-font-mono)", fontSize: "13px", fontWeight: 500 }}>
                      {f.path}
                    </span>
                    <Badge variant={f.status === "added" ? "success" : f.status === "deleted" ? "danger" : "warning"} size="sm">
                      {f.status.toUpperCase()}
                    </Badge>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", fontFamily: "var(--ds-font-mono)" }}>
                    <span style={{ color: "var(--success-strong)" }}>+{f.additions}</span>
                    <span style={{ color: "var(--danger-strong)" }}>-{f.deletions}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab View 3: History */}
      {activeTab === "history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title="Git 提交历史"
            subtitle="确定性提交日志与本地仓库最近变更记录"
          />

          {commitsQuery.isLoading ? (
            <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
              正在加载提交记录...
            </div>
          ) : (
            <DataTable
              columns={commitColumns}
              data={commitsQuery.data?.commits || []}
              keyExtractor={c => c.sha}
              onRowClick={c => setSelectedCommit(c)}
            />
          )}
        </div>
      )}

      {/* Tab View 4: Pull Requests */}
      {activeTab === "pull-requests" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title="拉取请求列表"
            subtitle="关联的 GitHub Pull Request 及其审查记录"
            actions={
              <div style={{ display: "flex", gap: "4px" }}>
                <Button variant={prFilter === "all" ? "primary" : "secondary"} size="sm" onClick={() => setPrFilter("all")}>
                  全部
                </Button>
                <Button variant={prFilter === "open" ? "primary" : "secondary"} size="sm" onClick={() => setPrFilter("open")}>
                  开启中
                </Button>
                <Button variant={prFilter === "merged" ? "primary" : "secondary"} size="sm" onClick={() => setPrFilter("merged")}>
                  已合并
                </Button>
                <Button variant={prFilter === "closed" ? "primary" : "secondary"} size="sm" onClick={() => setPrFilter("closed")}>
                  已关闭
                </Button>
              </div>
            }
          />

          {prsQuery.isLoading ? (
            <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
              正在拉取 Pull Request 列表...
            </div>
          ) : filteredPRs.length === 0 ? (
            <EmptyState
              icon={<GitPullRequest size={36} />}
              title="暂无 Pull Request 记录"
              description="该仓库未检测到公开 Pull Request 历史。您可以通过输入 GitHub PR 链接开始审查。"
            />
          ) : (
            <DataTable
              columns={prColumns}
              data={filteredPRs}
              keyExtractor={pr => String(pr.number)}
              onRowClick={pr => {
                if (pr.jobId) navigate(`/runs/${encodeURIComponent(pr.jobId)}/overview`);
              }}
            />
          )}
        </div>
      )}

      {/* Tab View 5: Reviews */}
      {activeTab === "reviews" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title="审查记录 (Review Runs)"
            subtitle="该代码仓库执行的所有代码质量与安全审查"
            actions={
              <Button
                variant="primary"
                size="sm"
                icon={<PlayCircle size={14} />}
                onClick={() => setIsComposerOpen(true)}
              >
                发起新审查
              </Button>
            }
          />

          {repoJobs.length === 0 ? (
            <EmptyState
              icon={<PlayCircle size={36} />}
              title="暂无历史审查记录"
              description="点击“发起新审查”为该仓库执行证据驱动的 AI 审查。"
              action={
                <Button variant="primary" size="md" icon={<PlayCircle size={14} />} onClick={() => setIsComposerOpen(true)}>
                  发起首次审查
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={reviewColumns}
              data={repoJobs}
              keyExtractor={job => job.id}
              onRowClick={job => navigate(`/runs/${encodeURIComponent(job.id)}/overview`)}
            />
          )}
        </div>
      )}

      {/* Tab View 6: Workflows */}
      {activeTab === "workflows" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionHeader
            title="工作流与触发策略"
            subtitle="该代码仓库绑定的代码审查工作流与自动化规则"
          />
          <EmptyState
            title="工作流拓扑就绪"
            description="当前代码仓库已绑定默认 PR 安全与代码质量审查工作流。"
          />
        </div>
      )}

      {/* Review Composer Dialog */}
      <ReviewComposerDialog
        isOpen={isComposerOpen}
        onClose={() => setIsComposerOpen(false)}
        repositoryId={repo.id}
      />
    </div>
  );
};
