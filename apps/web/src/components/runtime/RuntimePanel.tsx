import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AgentRuntimeSnapshot,
  CapabilityDescriptorSnapshot,
  ContextPageMetadataSnapshot,
  ReviewJob,
  ReviewReport,
  RunRuntimeSnapshot,
  SecurityGuarantees,
} from "@consistency/schema";
import {
  Activity,
  Box,
  CheckCircle2,
  Cpu,
  Layers,
  LoaderCircle,
  Lock,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  Terminal,
  Zap,
} from "lucide-react";
import { api } from "../../api/client";
import { useI18n } from "../../i18n";
import { workspaceQueryKeys } from "../../query/client";
import { safeRequestError } from "../../query/safeRequestError";

function formatStateLabel(state: string, zh: boolean): string {
  switch (state) {
    case "NEW": return zh ? "新建" : "NEW";
    case "READY": return zh ? "就绪" : "READY";
    case "RUNNING": return zh ? "运行中" : "RUNNING";
    case "WAIT_LLM": return zh ? "等待模型" : "WAIT_LLM";
    case "WAIT_TOOL": return zh ? "等待工具" : "WAIT_TOOL";
    case "WAIT_IO": return zh ? "等待 I/O" : "WAIT_IO";
    case "WAIT_AGENT": return zh ? "等待智能体" : "WAIT_AGENT";
    case "WAIT_HUMAN": return zh ? "等待人工" : "WAIT_HUMAN";
    case "SUSPENDED": return zh ? "已挂起" : "SUSPENDED";
    case "SUCCEEDED": return zh ? "已成功" : "SUCCEEDED";
    case "FAILED": return zh ? "已失败" : "FAILED";
    case "CANCELLED": return zh ? "已取消" : "CANCELLED";
    case "CREATED": return zh ? "已创建" : "CREATED";
    case "ACTIVE": return zh ? "活跃" : "ACTIVE";
    default: return state;
  }
}

function stateBadgeClass(state: string): string {
  if (state === "RUNNING") return "status-badge status-running";
  if (state.startsWith("WAIT_")) return "status-badge status-queued";
  if (state === "SUCCEEDED") return "status-badge status-succeeded";
  if (state === "FAILED") return "status-badge status-failed";
  if (state === "CANCELLED") return "status-badge status-cancelled";
  return "status-badge status-idle";
}

function SecurityGuaranteesPanel({ guarantees, zh }: { guarantees: SecurityGuarantees; zh: boolean }) {
  const items = [
    { label: zh ? "进程内存隔离" : "Process Memory Isolation", status: guarantees.processMemoryIsolation },
    { label: zh ? "环境变量密钥隔离" : "Parent Env Secret Isolation", status: guarantees.parentEnvSecretIsolation },
    { label: zh ? "Kernel RPC 鉴权" : "Kernel RPC Authorization", status: guarantees.kernelRpcAuthorization },
    { label: zh ? "文件系统 OS 隔离" : "Filesystem OS Containment", status: guarantees.filesystemOsContainment },
    { label: zh ? "网络 OS 隔离" : "Network OS Containment", status: guarantees.networkOsContainment },
    { label: zh ? "子进程 OS 隔离" : "Subprocess OS Containment", status: guarantees.subprocessOsContainment },
  ];

  return (
    <section className="section-block runtime-security-panel">
      <div className="panel-title">
        <div>
          <span className="panel-kicker">{zh ? "安全保证维度" : "Security Guarantee Dimensions"}</span>
          <h2>{zh ? "执行边界与隔离状态" : "Execution Boundary & Isolation Status"}</h2>
        </div>
        <Shield size={18} className="panel-icon" />
      </div>

      <div className="security-guarantees-grid">
        {items.map((item) => {
          const enforced = item.status === "enforced";
          return (
            <div
              key={item.label}
              className={`security-guarantee-card ${enforced ? "enforced" : "not-enforced"}`}
            >
              <div className="guarantee-header">
                {enforced ? (
                  <CheckCircle2 size={16} className="icon-enforced" />
                ) : (
                  <ShieldAlert size={16} className="icon-not-enforced" />
                )}
                <span className="guarantee-title">{item.label}</span>
              </div>
              <span className={`guarantee-status-pill ${enforced ? "enforced" : "not-enforced"}`}>
                {enforced
                  ? zh ? "已强制" : "ENFORCED"
                  : zh ? "未强制" : "NOT ENFORCED"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AgentDetailDrawer({
  agent,
  zh,
  onClose,
}: {
  agent: AgentRuntimeSnapshot;
  zh: boolean;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"process" | "capabilities" | "context" | "sandbox">("process");

  return (
    <div className="agent-detail-drawer" role="dialog" aria-label={agent.label}>
      <div className="drawer-header">
        <div>
          <span className="panel-kicker">{zh ? "智能体进程详情" : "Agent Process Detail"}</span>
          <h3>{agent.label} <code>({agent.agentId})</code></h3>
        </div>
        <button type="button" className="drawer-close-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="drawer-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "process"}
          className={activeTab === "process" ? "active" : ""}
          onClick={() => setActiveTab("process")}
        >
          {zh ? "进程 ACB" : "Process ACB"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "capabilities"}
          className={activeTab === "capabilities" ? "active" : ""}
          onClick={() => setActiveTab("capabilities")}
        >
          {zh ? `能力 (${agent.capabilities.length})` : `Capabilities (${agent.capabilities.length})`}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "context"}
          className={activeTab === "context" ? "active" : ""}
          onClick={() => setActiveTab("context")}
        >
          {zh ? "上下文 VM" : "Context VM"}
        </button>
        {agent.executionDomain === "child-process" && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "sandbox"}
            className={activeTab === "sandbox" ? "active" : ""}
            onClick={() => setActiveTab("sandbox")}
          >
            {zh ? "沙箱 Session" : "Sandbox Session"}
          </button>
        )}
      </div>

      <div className="drawer-body">
        {activeTab === "process" && (
          <div className="drawer-section">
            <div className="kv-grid">
              <div><strong>{zh ? "状态" : "State"}</strong><span className={stateBadgeClass(agent.state)}>{formatStateLabel(agent.state, zh)}</span></div>
              <div><strong>{zh ? "优先级" : "Priority"}</strong><span>{agent.priority}</span></div>
              <div><strong>{zh ? "特权环" : "Logical Ring"}</strong><span>Ring {agent.logicalRing}</span></div>
              <div><strong>{zh ? "执行域" : "Execution Domain"}</strong><code>{agent.executionDomain}</code></div>
              <div><strong>{zh ? "父进程 ID" : "Parent Agent"}</strong><code>{agent.parent ?? (zh ? "无 (根节点)" : "None (Root)")}</code></div>
              <div><strong>{zh ? "子进程数" : "Children"}</strong><span>{agent.children.length}</span></div>
              {agent.pendingOperation && (
                <div className="kv-wide">
                  <strong>{zh ? "等待操作" : "Pending Operation"}</strong>
                  <div className="pending-op-badge">
                    <code>{agent.pendingOperation.kind}</code>
                    <span>{agent.pendingOperation.description}</span>
                  </div>
                </div>
              )}
              {agent.budgets && (
                <div className="kv-wide">
                  <strong>{zh ? "预算上限" : "Budget Policy"}</strong>
                  <span>
                    {agent.budgets.tokenBudget !== undefined && `${zh ? "Token 上限" : "Token Limit"}: ${agent.budgets.tokenBudget} `}
                    {agent.budgets.wallTimeBudgetMs !== undefined && `${zh ? "时长上限" : "Time Limit"}: ${agent.budgets.wallTimeBudgetMs}ms`}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "capabilities" && (
          <div className="drawer-section">
            {agent.capabilities.length === 0 ? (
              <div className="empty-inline">{zh ? "此智能体未绑定任何能力。" : "No capabilities bound to this agent."}</div>
            ) : (
              <div className="capabilities-list">
                {agent.capabilities.map((cap, i) => (
                  <div key={`${cap.action}-${cap.handleFingerprint}-${i}`} className="capability-card">
                    <div className="cap-header">
                      <code>{cap.action}</code>
                      <span className="fingerprint-pill">fp:{cap.handleFingerprint}</span>
                    </div>
                    <div className="cap-body">
                      <span><strong>{zh ? "资源类型" : "Resource Kind"}:</strong> {cap.resourceKind}</span>
                      {cap.resourceId && <span><strong>{zh ? "资源目标" : "Resource Target"}:</strong> {cap.resourceId}</span>}
                      {cap.scope && (
                        <span>
                          <strong>{zh ? "范围约束" : "Scope"}:</strong> {cap.scope.sha ? `sha:${cap.scope.sha.slice(0, 7)} ` : ""}
                          {cap.scope.paths ? `paths:[${cap.scope.paths.join(", ")}]` : ""}
                        </span>
                      )}
                      {cap.revoked && <span className="revoked-badge">{zh ? "已撤销" : "REVOKED"}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "context" && (
          <div className="drawer-section">
            {agent.contextImageId ? (
              <div className="context-detail">
                <div><strong>ContextImageId:</strong> <code>{agent.contextImageId}</code></div>
              </div>
            ) : (
              <div className="empty-inline">{zh ? "无关联的 ContextImage。" : "No associated ContextImage."}</div>
            )}
          </div>
        )}

        {activeTab === "sandbox" && agent.sandbox && (
          <div className="drawer-section">
            <div className="kv-grid">
              <div><strong>Session ID:</strong> <code>{agent.sandbox.sessionId}</code></div>
              <div><strong>{zh ? "进程 PID" : "Process PID"}:</strong> <code>{agent.sandbox.pid ?? "N/A"}</code></div>
              <div><strong>{zh ? "插件 ID" : "Plugin ID"}:</strong> <span>{agent.sandbox.pluginId}</span></div>
              <div><strong>{zh ? "RPC 协议" : "RPC Protocol"}:</strong> <span>v{agent.sandbox.protocolVersion}</span></div>
              <div><strong>{zh ? "终止原因" : "Termination Reason"}:</strong> <span>{agent.sandbox.terminationReason ?? "N/A"}</span></div>
              <div><strong>{zh ? "错误代码" : "Error Code"}:</strong> <span>{agent.sandbox.errorCode ?? "N/A"}</span></div>
            </div>
            {agent.sandbox.diagnostics && (
              <div className="sandbox-diagnostics">
                <strong>{zh ? "沙箱诊断输出 (stderr)" : "Sandbox Diagnostics (stderr)"}</strong>
                <pre>{agent.sandbox.diagnostics}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function RuntimePanel({
  runId,
  job,
  report,
}: {
  runId: string;
  job?: ReviewJob;
  report?: ReviewReport;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const runtimeQuery = useQuery({
    queryKey: workspaceQueryKeys.runtimeSnapshot(runId),
    queryFn: ({ signal }) => api.runtimeSnapshot(runId, signal),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data?.telemetryStatus === "live" ? 1500 : false),
  });

  const snapshot: RunRuntimeSnapshot | undefined = runtimeQuery.data;
  const loading = runtimeQuery.isPending;
  const error = runtimeQuery.error ? safeRequestError(runtimeQuery.error) : undefined;

  if (loading) {
    return (
      <div className="loading-state">
        <LoaderCircle className="spinning" size={20} />
        <span>{zh ? "正在加载运行架构遥测..." : "Loading runtime telemetry..."}</span>
      </div>
    );
  }

  if (error || !snapshot || snapshot.telemetryStatus === "unavailable") {
    return (
      <div className="run-mode-route">
        <div className="empty-state runtime-unavailable-state">
          <Activity size={32} className="muted-icon" />
          <h3>{zh ? "遥测数据不可用" : "Runtime Telemetry Unavailable"}</h3>
          <p>
            {zh
              ? "该运行暂无实时 Kernel 遥测快照（早于 v3 运行时可观测性支持或日志已过期）。"
              : "No live Kernel telemetry snapshot is available for this run (predates v3 runtime observability or retention expired)."}
          </p>
          {job && (
            <div className="legacy-fallback-info">
              <span><strong>{zh ? "关联 ReviewJob 状态" : "Associated ReviewJob State"}:</strong> <code>{job.status}</code></span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const selectedAgent = snapshot.agents.find((a) => a.agentId === selectedAgentId);

  return (
    <div className="run-runtime-panel page-stack">
      {/* Top Overview Cards */}
      <section className="section-block runtime-overview-header">
        <div className="runtime-summary-bar">
          <div className="summary-item">
            <span className="summary-label">{zh ? "运行 ID / RunId" : "Run ID"}</span>
            <code>{snapshot.runId}</code>
          </div>
          <div className="summary-item">
            <span className="summary-label">{zh ? "遥测状态" : "Telemetry Status"}</span>
            <span className={`status-pill telemetry-${snapshot.telemetryStatus}`}>
              {snapshot.telemetryStatus === "live" ? (
                <><RefreshCw size={12} className="spinning" /> {zh ? "实时运行" : "LIVE"}</>
              ) : (
                <><CheckCircle2 size={12} /> {zh ? "已完成快照" : "COMPLETED SNAPSHOT"}</>
              )}
            </span>
          </div>
          <div className="summary-item">
            <span className="summary-label">{zh ? "运行状态" : "Run State"}</span>
            <span className={stateBadgeClass(snapshot.state)}>{formatStateLabel(snapshot.state, zh)}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">{zh ? "并发限制" : "Concurrency"}</span>
            <strong>{snapshot.concurrency}</strong>
          </div>
          <div className="summary-item">
            <span className="summary-label">{zh ? "进程数" : "Agent Process Counts"}</span>
            <div className="agent-count-pills">
              <span className="pill-running">{snapshot.agentCounts.running} {zh ? "运行" : "running"}</span>
              <span className="pill-waiting">{snapshot.agentCounts.waiting} {zh ? "等待" : "waiting"}</span>
              <span className="pill-terminal">{snapshot.agentCounts.terminal} {zh ? "终止" : "terminal"}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Security Guarantees */}
      <SecurityGuaranteesPanel guarantees={snapshot.securityGuarantees} zh={zh} />

      {/* Context VM Overview */}
      {snapshot.context && (
        <section className="section-block context-vm-summary-panel">
          <div className="panel-title">
            <div>
              <span className="panel-kicker">{zh ? "虚拟上下文" : "Context VM"}</span>
              <h2>{zh ? "工作集与 COW 页面分布" : "WorkingSet & Page Table Distribution"}</h2>
            </div>
            <Layers size={18} className="panel-icon" />
          </div>

          <div className="context-vm-grid">
            <div className="vm-stat-card">
              <span className="stat-label">{zh ? "工作集估算 Token" : "Working Set Estimated Tokens"}</span>
              <strong className="stat-value">{snapshot.context.workingSetTokens.toLocaleString()}</strong>
              <small className="stat-sub">{zh ? "仅为 ContextVM 估算值，非模型实际消费" : "ContextVM estimate, not actual model tokens"}</small>
            </div>
            <div className="vm-stat-card">
              <span className="stat-label">{zh ? "活动页面总数" : "Working Set Page Count"}</span>
              <strong className="stat-value">{snapshot.context.workingSetPageCount}</strong>
            </div>
            <div className="vm-stat-card">
              <span className="stat-label">{zh ? "页面驻留分布 (Residency)" : "Page Residency Distribution"}</span>
              <div className="residency-pills">
                {Object.entries(snapshot.context.pageCountsByResidency).map(([res, count]) => (
                  <span key={res} className={`residency-pill res-${res.toLowerCase()}`}>
                    {res.toUpperCase()}: {count}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Page Metadata Table */}
          {snapshot.context.pages.length > 0 && (
            <div className="context-pages-table-wrapper">
              <table className="context-pages-table">
                <thead>
                  <tr>
                    <th>{zh ? "页面 ID" : "Page ID"}</th>
                    <th>{zh ? "类型 Kind" : "Kind"}</th>
                    <th>{zh ? "驻留状态" : "Residency"}</th>
                    <th>{zh ? "估算 Token" : "Est. Tokens"}</th>
                    <th>{zh ? "内容 Hash" : "Content Hash"}</th>
                    <th>{zh ? "来源引用" : "Source Ref"}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.context.pages.map((p) => (
                    <tr key={p.pageId}>
                      <td><code>{p.pageId}</code></td>
                      <td><span className="kind-tag">{p.kind}</span></td>
                      <td><span className={`residency-pill res-${p.residency.toLowerCase()}`}>{p.residency}</span></td>
                      <td>{p.estimatedTokens}</td>
                      <td><code>{p.contentHash}</code></td>
                      <td>{p.sourceRef ? <code>{p.sourceRef}</code> : <span className="muted-text">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Agent Process Table / Tree */}
      <section className="section-block agent-processes-panel">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">{zh ? "Kernel 进程模型" : "Kernel Process Model"}</span>
            <h2>{zh ? "智能体进程层级与状态" : "Agent Process Hierarchy & States"}</h2>
          </div>
          <Cpu size={18} className="panel-icon" />
        </div>

        <div className="agent-table-wrapper">
          <table className="agent-process-table">
            <thead>
              <tr>
                <th>{zh ? "智能体 Label / AgentId" : "Agent Label / ID"}</th>
                <th>{zh ? "状态" : "State"}</th>
                <th>{zh ? "优先级" : "Priority"}</th>
                <th>{zh ? "执行域" : "Execution Domain"}</th>
                <th>{zh ? "特权环" : "Ring"}</th>
                <th>{zh ? "当前等待操作" : "Pending Operation"}</th>
                <th>{zh ? "能力数" : "Capabilities"}</th>
                <th>{zh ? "沙箱状态" : "Sandbox Status"}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.agents.map((agent) => (
                <tr
                  key={agent.agentId}
                  className={`agent-row ${selectedAgentId === agent.agentId ? "selected" : ""}`}
                  onClick={() => setSelectedAgentId(agent.agentId)}
                >
                  <td className="agent-id-cell">
                    <div className="agent-label-wrapper">
                      <strong>{agent.label}</strong>
                      <code>{agent.agentId}</code>
                    </div>
                  </td>
                  <td>
                    <span className={stateBadgeClass(agent.state)}>
                      {formatStateLabel(agent.state, zh)}
                    </span>
                  </td>
                  <td>{agent.priority}</td>
                  <td>
                    <span className={`domain-badge domain-${agent.executionDomain}`}>
                      {agent.executionDomain === "child-process" ? (
                        <><Box size={12} /> {zh ? "子进程" : "child-process"}</>
                      ) : (
                        <><Zap size={12} /> {zh ? "进程内" : "in-process"}</>
                      )}
                    </span>
                  </td>
                  <td>Ring {agent.logicalRing}</td>
                  <td>
                    {agent.pendingOperation ? (
                      <span className="pending-op-summary">
                        <code>{agent.pendingOperation.kind}</code> {agent.pendingOperation.description}
                      </span>
                    ) : (
                      <span className="muted-text">—</span>
                    )}
                  </td>
                  <td>{agent.capabilities.length}</td>
                  <td>
                    {agent.sandbox ? (
                      <span className={`sandbox-pill sbx-${agent.sandbox.state}`}>
                        PID {agent.sandbox.pid ?? "?"} · {agent.sandbox.state}
                      </span>
                    ) : (
                      <span className="muted-text">{zh ? "N/A (进程内)" : "N/A (in-process)"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Selected Agent Detail Drawer */}
      {selectedAgent && (
        <AgentDetailDrawer
          agent={selectedAgent}
          zh={zh}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}
