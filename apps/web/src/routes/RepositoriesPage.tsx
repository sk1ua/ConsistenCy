import { useMemo } from "react";
import type { HeartbeatPulse, Repository, ReviewJob } from "@consistency/schema";
import { Activity, Clock3, FolderGit2, FolderPlus, GitBranch, History, LoaderCircle, PauseCircle, PlayCircle, Radio, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n";

function localRepositoryName(pulse: HeartbeatPulse): string {
  if (pulse.repository.root === "unknown") return "Local repository";
  const segments = pulse.repository.root.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? "Local repository";
}

function sourceLabel(job: ReviewJob, locale: "en-US" | "zh-CN"): string {
  if (job.accessMode === "local_git") return locale === "zh-CN" ? "本地审查" : "Local review";
  if (job.accessMode === "public_read") return locale === "zh-CN" ? "公开只读" : "Public read";
  return "GitHub App";
}

export function RepositoriesPage({
  jobs,
  pulse,
  heartbeatUnavailable,
  jobsUnavailable,
  repositories = [],
  registryUnavailable = false,
  canSelectRepository = false,
  addingRepository = false,
  addRepositoryError,
  monitoringError,
  onAddRepository,
  monitoringRepositoryId,
  onSetMonitoring
}: {
  jobs: ReviewJob[];
  pulse: HeartbeatPulse | null;
  heartbeatUnavailable: boolean;
  jobsUnavailable: boolean;
  repositories?: Repository[];
  registryUnavailable?: boolean;
  canSelectRepository?: boolean;
  addingRepository?: boolean;
  addRepositoryError?: string;
  monitoringError?: string;
  onAddRepository?: () => void;
  monitoringRepositoryId?: string;
  onSetMonitoring?: (repository: Repository, enabled: boolean) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const sources = useMemo(() => {
    const byName = new Map<string, ReviewJob>();
    for (const job of [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!byName.has(job.repositoryFullName)) byName.set(job.repositoryFullName, job);
    }
    return [...byName.values()];
  }, [jobs]);

  return <div className="repository-route page-stack">
    <section className="repository-route-intro">
      <div><span className="panel-kicker"><Radio size={14} />{zh ? "真实来源" : "Observed sources"}</span><h2>{zh ? "只展示当前运行时确实看见的仓库。" : "Only repositories observed by this runtime appear here."}</h2><p>{zh ? "实时监控来自 Heartbeat；其余条目从真实审查任务历史推导，不会冒充持续监控。" : "Live monitoring comes from Heartbeat. Other entries are derived from real review history and are not presented as continuously monitored."}</p></div>
      <div className="repository-source-count"><strong>{repositories.length + sources.filter(job => !repositories.some(repository => repository.remoteFullName === job.repositoryFullName)).length}</strong><span>{zh ? "个可核实来源" : "verifiable sources"}</span></div>
    </section>

    <section className="repository-section section-block">
      <div className="panel-title"><div><span className="panel-kicker">{zh ? "持久范围" : "Persistent scope"}</span><h2>{zh ? "已注册仓库" : "Registered repositories"}</h2></div>{canSelectRepository && <button className="primary-button" type="button" disabled={addingRepository} onClick={onAddRepository}>{addingRepository ? <LoaderCircle className="spinning" size={15} /> : <FolderPlus size={15} />}{zh ? "选择仓库" : "Select repository"}</button>}</div>
      {addRepositoryError && <div className="route-query-notice" role="alert"><strong>{zh ? "无法注册仓库" : "Could not register repository"}</strong><span>{addRepositoryError}</span></div>}
      {monitoringError && <div className="route-query-notice" role="alert"><strong>{zh ? "无法更新监控状态" : "Could not update monitoring"}</strong><span>{monitoringError}</span></div>}
      {registryUnavailable ? <div className="repository-honest-empty"><FolderGit2 size={20} /><div><strong>{zh ? "仓库注册表暂不可用" : "Repository registry is unavailable"}</strong><p>{zh ? "审查历史仍保持独立；API 恢复后可重试。" : "Review history remains independent. Retry after the API recovers."}</p></div></div>
        : repositories.length === 0 ? <div className="repository-honest-empty"><FolderPlus size={20} /><div><strong>{zh ? "尚未注册持久仓库" : "No persistent repositories yet"}</strong><p>{canSelectRepository ? (zh ? "通过系统目录选择器添加 Git 工作树；路径只由 Electron 主进程和 API 持有。" : "Add a Git worktree through the system picker. Its path stays in Electron main and the API.") : (zh ? "请在 Electron 桌面应用中使用受保护的目录选择器。" : "Use the protected folder picker in the Electron desktop app.")}</p></div></div>
          : <div className="repository-registry" role="list">{repositories.map(repository => <article className="repository-registry-row" role="listitem" key={repository.id}>
            <Link to={`/repositories/${encodeURIComponent(repository.id)}`}><FolderGit2 size={17} /><span><strong>{repository.displayName}</strong><small>{repository.source} · {repository.trustLevel === "trusted_local" ? (zh ? "受信本地" : "trusted local") : (zh ? "静态只读" : "static read-only")}</small></span></Link>
            <span className={repository.monitoringEnabled ? "repository-monitoring enabled" : "repository-monitoring"}><i />{repository.monitoringEnabled ? (zh ? "监控中" : "Monitored") : (zh ? "已暂停" : "Paused")}</span>
            {onSetMonitoring && <button type="button" disabled={monitoringRepositoryId === repository.id} onClick={() => onSetMonitoring(repository, !repository.monitoringEnabled)}>{repository.monitoringEnabled ? <PauseCircle size={15} /> : <PlayCircle size={15} />}{repository.monitoringEnabled ? (zh ? "暂停" : "Pause") : (zh ? "恢复" : "Resume")}</button>}
          </article>)}</div>}
    </section>

    <section className="repository-section section-block">
      <div className="panel-title"><div><span className="panel-kicker">{zh ? "本地守护" : "Local daemon"}</span><h2>{zh ? "实时仓库监控" : "Live repository monitor"}</h2></div></div>
      {pulse ? <article className="repository-monitor-card">
        <div className="repository-monitor-title"><span className={`repository-live-state state-${pulse.state}`}><i />{pulse.state}</span><FolderGit2 size={20} /><strong>{localRepositoryName(pulse)}</strong><code>{pulse.repository.headSha?.slice(0, 10) ?? "working tree"}</code></div>
        <div className="repository-monitor-metrics">
          <span><GitBranch size={14} />{pulse.repository.branch ?? (zh ? "分离头指针" : "detached")}</span>
          <span><Activity size={14} />{pulse.dirtyFileCount} {zh ? "个脏文件" : "dirty files"}</span>
          <span><ShieldCheck size={14} />{pulse.metrics ? `${Math.round(pulse.metrics.riskIndex * 100)} ${zh ? "风险指数" : "risk index"}` : (zh ? "风险待计算" : "risk pending")}</span>
          <span><Clock3 size={14} />{new Date(pulse.observedAt).toLocaleTimeString(locale)}</span>
        </div>
        <Link className="repository-open-link" to={`/repositories/${encodeURIComponent(`local:${localRepositoryName(pulse)}`)}`}>{zh ? "打开仓库深链" : "Open repository deep link"}</Link>
      </article> : <div className="repository-honest-empty">
        <Radio size={20} /><div><strong>{heartbeatUnavailable ? (zh ? "Heartbeat 当前不可用" : "Heartbeat is unavailable") : (zh ? "等待第一个仓库脉冲" : "Waiting for the first repository pulse")}</strong><p>{zh ? "尚未收到可验证的实时仓库状态，因此这里不创建占位仓库。" : "No verifiable live repository state has arrived, so no placeholder repository is created."}</p></div>
      </div>}
    </section>

    <section className="repository-section section-block">
      <div className="panel-title"><div><span className="panel-kicker"><History size={14} />{zh ? "审查历史" : "Review history"}</span><h2>{zh ? "已观察的审查来源" : "Observed review sources"}</h2></div><span className="repository-derived-label">{zh ? "非持续监控" : "not continuously monitored"}</span></div>
      {jobsUnavailable ? <div className="repository-honest-empty"><History size={20} /><div><strong>{zh ? "无法读取任务历史" : "Review history is unavailable"}</strong><p>{zh ? "实时监控状态仍保持独立；恢复 API 后可重试任务来源。" : "The live monitor remains independent. Retry review sources after the API recovers."}</p></div></div>
        : sources.length === 0 ? <div className="repository-honest-empty"><History size={20} /><div><strong>{zh ? "还没有审查来源" : "No review sources yet"}</strong><p>{zh ? "分析公开 PR 或本地仓库后，来源会出现在这里。" : "Analyze a public PR or local repository to create the first source."}</p></div></div>
        : <div className="repository-source-table" role="list">{sources.map(job => <Link to={`/repositories/${encodeURIComponent(job.repositoryFullName)}`} key={job.repositoryFullName} className="repository-source-row" role="listitem">
          <FolderGit2 size={17} /><span><strong>{job.repositoryFullName}</strong><small>{sourceLabel(job, locale)} · {new Date(job.createdAt).toLocaleString(locale)}</small></span><code>{job.headSha.slice(0, 9)}</code><span className={`badge badge-${job.status}`}>{job.status}</span>
        </Link>)}</div>}
    </section>
  </div>;
}
