import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PlayCircle,
  PauseCircle,
  Plus,
  Loader2,
  Workflow as WorkflowIcon,
  RefreshCw
} from "lucide-react";
import type {
  WorkflowRuntimeBinding,
  WorkflowRuntimeDefinitionSummary,
  WorkflowRuntimeRunSummary,
  WorkflowRuntimeRunV2
} from "@consistency/schema";
import { api } from "../api/client";
import { Button } from "../design-system/Button";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";

/**
 * Repository-local Workflows view (CKPT3 Phase 3): real binding surface.
 * Bindings are data/intent — enabling one never authorizes anything; runs
 * execute through the canonical revision-pinned Kernel/Harness chain.
 */
export function RepositoryWorkflowsView({
  repositoryId,
  zh
}: {
  repositoryId: string;
  zh: boolean;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string>();
  const [activeRun, setActiveRun] = useState<WorkflowRuntimeRunV2 | null>(null);

  const bindingsQuery = useQuery({
    queryKey: ["workflow-runtime-bindings", repositoryId],
    queryFn: () => api.workflowRuntimeBindings(repositoryId),
    retry: false
  });
  const definitionsQuery = useQuery({
    queryKey: ["workflow-runtime-definitions"],
    queryFn: () => api.workflowRuntimeDefinitions(),
    retry: false
  });
  const runsQuery = useQuery({
    queryKey: ["workflow-runtime-repo-runs", repositoryId],
    queryFn: () => api.workflowRuntimeRunsForRepository(repositoryId, 20),
    retry: false
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["workflow-runtime-bindings", repositoryId] });
    await queryClient.invalidateQueries({ queryKey: ["workflow-runtime-repo-runs", repositoryId] });
  };

  const toggleBinding = useMutation({
    mutationFn: (input: { definitionId: string; enabled: boolean; triggerMode?: "manual" | "on_change" }) =>
      api.setWorkflowRuntimeBinding(repositoryId, input.definitionId, input.enabled, input.triggerMode),
    onSuccess: () => void invalidate(),
    onError: (error: Error) => setActionError(error.message)
  });

  const triggerRun = useMutation({
    mutationFn: (definitionId: string) => api.triggerWorkflowRuntimeForRepository(repositoryId, definitionId),
    onSuccess: async (created) => {
      setActionError(undefined);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await api.workflowRuntimeRunV2(created.runId);
        setActiveRun(current);
        if (current.status !== "running") {
          await invalidate();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      setActionError(zh ? "等待运行结束超时" : "Timed out waiting for the run to finish");
    },
    onError: (error: Error) => setActionError(error.message)
  });

  const bindings = bindingsQuery.data ?? [];
  const definitions = definitionsQuery.data ?? [];
  const boundIds = new Set(bindings.map((binding) => binding.definitionId));
  const bindable = definitions.filter((definition) => !boundIds.has(definition.definitionId));
  const runs = runsQuery.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <SectionHeader
        title={zh ? "仓库工作流" : "Repository Workflows"}
        subtitle={
          zh
            ? "绑定的工作流定义与手动触发；触发始终解析最新的已验证 revision 并钉定仓库 HEAD 快照"
            : "Bound workflow definitions with manual triggering; triggers resolve the latest validated revision and pin the repository HEAD snapshot"
        }
        actions={
          <Link
            to="/workflows?tab=runtime"
            className="secondary-button btn-small"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", textDecoration: "none" }}
          >
            <WorkflowIcon size={14} />
            {zh ? "管理工作流" : "Manage workflows"}
          </Link>
        }
      />

      {actionError && (
        <div role="alert" style={{ padding: "10px 14px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", background: "var(--surface)" }}>
          <strong>{zh ? "操作被拒绝（fail-closed）" : "Action refused (fail-closed)"}</strong>
          <div style={{ fontSize: "13px", color: "var(--text-muted, var(--muted))" }}>{actionError}</div>
        </div>
      )}

      {/* Bound workflows */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", background: "var(--surface)", padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <strong>{zh ? "此仓库启用的工作流" : "Workflows for this repository"}</strong>
          <Button variant="ghost" size="sm" onClick={() => void runsQuery.refetch()}>
            <RefreshCw size={13} />
            {zh ? "刷新" : "Refresh"}
          </Button>
        </div>
        {bindingsQuery.isLoading ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--muted)" }}>
            <Loader2 size={14} className="animate-spin" />
            {zh ? "加载中…" : "Loading…"}
          </div>
        ) : bindingsQuery.isError ? (
          <div role="alert" style={{ color: "var(--muted)" }}>
            {zh ? "绑定列表不可用（加载失败，非空状态）。" : "Bindings unavailable (failed to load — not an empty state)."}
          </div>
        ) : bindings.length === 0 ? (
          <EmptyState
            title={zh ? "尚未绑定工作流" : "No workflow bindings yet"}
            description={zh ? "尚无绑定（空 ≠ 不可用）。从下方可用定义中启用一个工作流。" : "No bindings yet (empty, not unavailable). Enable one from the available definitions below."}
          />
        ) : (
          <div role="list" style={{ display: "grid", gap: "8px" }}>
            {bindings.map((binding) => (
              <BindingRow
                key={binding.definitionId}
                binding={binding}
                zh={zh}
                pending={toggleBinding.isPending || triggerRun.isPending}
                onToggle={(enabled) => {
                  setActionError(undefined);
                  toggleBinding.mutate({ definitionId: binding.definitionId, enabled });
                }}
                onSetMode={(triggerMode) => {
                  setActionError(undefined);
                  toggleBinding.mutate({ definitionId: binding.definitionId, enabled: binding.enabled, triggerMode });
                }}
                onTrigger={() => {
                  setActionError(undefined);
                  triggerRun.mutate(binding.definitionId);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bindable definitions */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", background: "var(--surface)", padding: "16px" }}>
        <strong style={{ display: "block", marginBottom: "12px" }}>{zh ? "可用工作流定义" : "Available workflow definitions"}</strong>
        {definitionsQuery.isLoading ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--muted)" }}>
            <Loader2 size={14} className="animate-spin" />
            {zh ? "加载中…" : "Loading…"}
          </div>
        ) : definitionsQuery.isError ? (
          <div role="alert" style={{ color: "var(--muted)" }}>
            {zh ? "定义列表不可用（加载失败）。" : "Definitions unavailable (failed to load)."}
          </div>
        ) : bindable.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: "13px" }}>
            {zh ? "所有已持久化定义均已绑定。" : "Every persisted definition is already bound."}
          </div>
        ) : (
          <div role="list" style={{ display: "grid", gap: "8px" }}>
            {bindable.map((definition) => (
              <div
                key={definition.definitionId}
                role="listitem"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-sm)" }}
              >
                <div>
                  <strong>{definition.definitionId}</strong>
                  <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                    {definition.origin === "builtin" ? (zh ? "内置" : "builtin") : zh ? "用户" : "user"}
                    {definition.latestRevision !== null ? ` · r${definition.latestRevision} ${definition.status === "validated" ? "✓" : "!"}` : ""}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggleBinding.isPending}
                  onClick={() => {
                    setActionError(undefined);
                    toggleBinding.mutate({ definitionId: definition.definitionId, enabled: true });
                  }}
                >
                  <Plus size={13} />
                  {zh ? "启用" : "Enable"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-repository run history */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", background: "var(--surface)", padding: "16px" }}>
        <strong style={{ display: "block", marginBottom: "12px" }}>{zh ? "Run 历史（本仓库）" : "Run history (this repository)"}</strong>
        {runsQuery.isLoading ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--muted)" }}>
            <Loader2 size={14} className="animate-spin" />
            {zh ? "加载中…" : "Loading…"}
          </div>
        ) : runsQuery.isError ? (
          <div role="alert" style={{ color: "var(--muted)" }}>
            {zh ? "Run 历史不可用（加载失败）。" : "Run history unavailable (failed to load)."}
          </div>
        ) : runs.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: "13px" }}>
            {zh ? "暂无 run 历史（空 ≠ 不可用）。" : "No runs yet (empty, not unavailable)."}
          </div>
        ) : (
          <div role="list" style={{ display: "grid", gap: "6px" }}>
            {runs.map((run) => (
              <button
                key={run.runId}
                type="button"
                role="listitem"
                onClick={() => void api.workflowRuntimeRunV2(run.runId).then(setActiveRun)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-sm)", background: "transparent", cursor: "pointer", textAlign: "left", color: "inherit" }}
              >
                <span style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: run.status === "succeeded" ? "var(--success, #22c55e)" : run.status === "failed" ? "var(--danger, #ef4444)" : "var(--muted)" }} />
                  <strong>{run.definitionId}</strong>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>{run.revisionId.slice(0, 14)}…</span>
                </span>
                <span style={{ fontSize: "12px", color: "var(--muted)", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  {run.trigger && (
                    <span
                      title={run.trigger.eventId}
                      style={{ border: "1px solid var(--border)", borderRadius: "var(--ds-radius-sm)", padding: "1px 6px" }}
                    >
                      {run.trigger.source === "repository_change" ? (zh ? "变更触发" : "change") : zh ? "手动" : "manual"}
                    </span>
                  )}
                  {run.evidenceCount} ev · {run.findingCount} {zh ? "发现" : "findings"} · {new Date(run.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Active / selected run detail */}
      {activeRun && (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--ds-radius-md)", background: "var(--surface)", padding: "16px" }}>
          <strong style={{ display: "block", marginBottom: "8px" }}>
            {zh ? "Run 详情" : "Run detail"} · {activeRun.status} · {activeRun.definitionId} @ {activeRun.revisionId.slice(0, 14)}…
          </strong>
          <div style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "8px" }}>
            {activeRun.snapshot.repository} @ {activeRun.snapshot.headSha.slice(0, 12)}
            {activeRun.trigger
              ? activeRun.trigger.source === "repository_change"
                ? ` · ${zh ? "变更触发" : "change-triggered"}${activeRun.trigger.eventId ? ` (${activeRun.trigger.eventId.slice(0, 22)}…)` : ""}`
                : ` · ${zh ? "手动触发" : "manual"}`
              : ""}
            {activeRun.miniReport ? ` · ${activeRun.miniReport.audit.allowed} allow / ${activeRun.miniReport.audit.denied} deny` : ""}
          </div>
          {activeRun.evidence.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: "grid", gap: 4 }}>
              {activeRun.evidence.map((record) => (
                <li key={record.id}>
                  <code>{record.ruleId ?? record.source}</code> {record.path}
                  {record.startLine ? `:${record.startLine}` : ""} · <code>{record.fingerprint.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
          )}
          {activeRun.error && <div style={{ fontSize: 12, color: "var(--muted)" }}>{activeRun.error}</div>}
        </div>
      )}
    </div>
  );
}

function BindingRow({
  binding,
  zh,
  pending,
  onToggle,
  onSetMode,
  onTrigger
}: {
  binding: WorkflowRuntimeBinding;
  zh: boolean;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onSetMode: (triggerMode: "manual" | "on_change") => void;
  onTrigger: () => void;
}) {
  const unavailable = binding.definition === null;
  const summary = binding.definition;
  return (
    <div
      role="listitem"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-sm)" }}
    >
      <div>
        <strong>{binding.definitionId}</strong>
        <div style={{ fontSize: "12px", color: "var(--muted)" }}>
          {unavailable || !summary
            ? zh ? "定义已删除（不可用）" : "definition deleted (unavailable)"
            : `${summary.origin === "builtin" ? (zh ? "内置" : "builtin") : zh ? "用户" : "user"}${summary.latestRevision !== null ? ` · r${summary.latestRevision} ${summary.status === "validated" ? "✓" : "!"}` : ""}`}
        </div>
        {binding.enabled && binding.triggerMode === "on_change" && (
          <div style={{ fontSize: "12px", color: "var(--muted)" }}>
            {zh
              ? "仓库变更事件将自动触发（每事件至多一次，钉定当时 HEAD）"
              : "Repository change events trigger automatically (at most once per event, pinned to the HEAD at that time)"}
          </div>
        )}
      </div>
      <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span>{zh ? "触发" : "Trigger"}</span>
          <select
            aria-label={zh ? "触发模式" : "Trigger mode"}
            value={binding.triggerMode}
            disabled={pending || unavailable}
            onChange={(event) => onSetMode(event.target.value as "manual" | "on_change")}
            style={{ fontSize: 12, padding: "2px 4px", border: "1px solid var(--border)", borderRadius: "var(--ds-radius-sm)", background: "var(--surface)" }}
          >
            <option value="manual">{zh ? "手动" : "Manual"}</option>
            <option value="on_change">{zh ? "变更时" : "On change"}</option>
          </select>
        </label>
        <span style={{ fontSize: 12, color: binding.enabled ? "var(--success, #22c55e)" : "var(--muted)" }}>
          {binding.enabled ? (zh ? "已启用" : "Enabled") : zh ? "已禁用" : "Disabled"}
        </span>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => onToggle(!binding.enabled)}>
          {binding.enabled ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
          {binding.enabled ? (zh ? "禁用" : "Disable") : zh ? "启用" : "Enable"}
        </Button>
        <Button variant="outline" size="sm" disabled={pending || !binding.enabled || unavailable} onClick={onTrigger}>
          {pending ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
          {zh ? "运行" : "Run"}
        </Button>
      </span>
    </div>
  );
}
