import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CalendarClock,
  CheckCircle2,
  GitBranch,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  Radio,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  GitFork,
  AlertCircle,
  Layers
} from "lucide-react";
import {
  collectWorkflowGraphIssues,
  workflowSpecSchema,
  type AuditCapabilities,
  type Automation,
  type Repository,
  type WorkflowSource,
  type WorkflowSpec,
  type WorkflowSummary
} from "@consistency/schema";
import { api } from "../api/client";
import { WorkflowGraph } from "../components/WorkflowGraph";
import { useI18n } from "../i18n";
import { Tabs, type TabItem } from "../design-system/Tabs";
import { Button } from "../design-system/Button";
import { Badge } from "../design-system/Badge";
import { SectionHeader } from "../design-system/SectionHeader";
import { EmptyState } from "../design-system/EmptyState";
import { Input } from "../design-system/Input";
import { Select } from "../design-system/Select";

const ANALYZER_KINDS = [
  "engine.style",
  "engine.structural",
  "engine.semantic",
  "engine.duplication",
  "engine.security",
  "tool.semgrep",
  "tool.ruff",
  "tool.eslint",
  "graph.dependency",
  "graph.schema_drift"
] as const;

const VERIFIER_KINDS = [
  "verify.unit_tests",
  "verify.build",
  "verify.syntax",
  "verify.llm_sanity"
] as const;

type AnyStep = WorkflowSpec["nodes"][number] | WorkflowSpec["verifiers"][number] | WorkflowSpec["synthesizer"];
type StepRole = "node" | "verifier" | "synthesizer";

function stepsOf(spec: WorkflowSpec): { step: AnyStep; role: StepRole }[] {
  return [
    ...spec.nodes.map(step => ({ step, role: "node" as const })),
    ...spec.verifiers.map(step => ({ step, role: "verifier" as const })),
    { step: spec.synthesizer, role: "synthesizer" as const }
  ];
}

function triggerLabel(automation: Automation, zh: boolean): string {
  if (automation.trigger.type === "manual") return zh ? "手动触发 (Manual)" : "Manual";
  if (automation.trigger.type === "schedule") return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  return automation.trigger.eventTypes.join(" · ");
}

function WorkflowTriggersView({
  automations = [],
  repositories = [],
  capabilities,
  actionError,
  changingAutomationId,
  onSetEnabled,
  zh
}: {
  automations?: Automation[];
  repositories?: Repository[];
  capabilities?: AuditCapabilities;
  actionError?: string;
  changingAutomationId?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
  zh: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-lg)",
          padding: "20px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
          <CalendarClock size={20} style={{ color: "var(--primary)" }} />
          <div>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>触发器策略与能力 (Triggers & Policies)</h3>
            <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
              控制代码审查工作流在何时何种场景下自动或手动执行
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: "16px", fontSize: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <CheckCircle2 size={14} color="var(--success)" />
            <span>手动触发与公开 PR 审查 (可用)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <CheckCircle2 size={14} color="var(--success)" />
            <span>GitHub Webhook 自动化审查 (可用)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--muted)" }}>
            <Radio size={14} />
            <span>定时计划 (后续里程碑)</span>
          </div>
        </div>
      </section>

      {actionError && (
        <div
          style={{
            padding: "12px 16px",
            background: "var(--danger-soft)",
            color: "var(--danger-strong)",
            borderRadius: "var(--ds-radius-md)",
            fontSize: "13px"
          }}
        >
          <strong>无法更新自动化策略: </strong>
          <span>{actionError}</span>
        </div>
      )}

      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--ds-radius-md)",
          padding: "16px"
        }}
      >
        <SectionHeader
          title={zh ? "已配置触发策略绑定" : "Configured Trigger Bindings"}
          subtitle={zh ? "已绑定到具体代码仓库的触发执行规则" : "Trigger execution rules bound to specific repositories"}
          actions={
            <Badge variant={capabilities?.automationScheduling ? "success" : "neutral"} size="sm">
              {capabilities?.automationScheduling ? (zh ? "调度引擎已就绪" : "Scheduler ready") : (zh ? "仅保存策略定义" : "Definitions only")}
            </Badge>
          }
        />

        {automations.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {automations.map(automation => {
              const repository = repositories.find(candidate => candidate.id === automation.repositoryId);
              return (
                <div
                  key={automation.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    background: "var(--surface-subtle)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--ds-radius-md)"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <Badge variant={automation.enabled ? "success" : "neutral"} size="sm" dot={automation.enabled}>
                      {automation.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已暂停" : "Paused")}
                    </Badge>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>{automation.name}</div>
                      <div style={{ fontSize: "11px", color: "var(--muted)" }}>
                        {zh ? "仓库" : "Repository"}: {repository?.displayName ?? automation.repositoryId}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "12px" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <CalendarClock size={14} color="var(--muted)" />
                      <span>{triggerLabel(automation, zh)}</span>
                    </span>
                    <Badge variant="neutral" size="sm" mono>
                      {automation.executionProfile === "static_readonly" ? (zh ? "静态只读" : "Static read-only") : (zh ? "受信沙箱" : "Trusted sandbox")}
                    </Badge>
                    {onSetEnabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={changingAutomationId === automation.id}
                        icon={automation.enabled ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
                        onClick={() => onSetEnabled(automation, !automation.enabled)}
                      >
                        {automation.enabled ? "暂停" : "恢复"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            compact
            icon={<CalendarClock size={28} />}
            title="暂无绑定的仓库触发策略"
            description="工作流当前通过 GitHub App Webhook 或工作区手动审查执行。"
          />
        )}
      </section>
    </div>
  );
}

export function WorkflowPage({
  automations = [],
  repositories = [],
  capabilities,
  actionError,
  changingAutomationId,
  onSetEnabled
}: {
  automations?: Automation[];
  repositories?: Repository[];
  capabilities?: AuditCapabilities;
  actionError?: string;
  changingAutomationId?: string;
  onSetEnabled?: (automation: Automation, enabled: boolean) => void;
} = {}) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") === "triggers" ? "triggers" : "definition";

  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [current, setCurrent] = useState<{ spec: WorkflowSpec; source: WorkflowSource } | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadList = useCallback(async () => {
    try {
      setSummaries(await api.workflows());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load workflows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!loading && summaries.length > 0 && current === null && error === undefined) {
      const first = summaries[0];
      if (first) void openWorkflow(first.name);
    }
  }, [loading, summaries, current, error]);

  async function openWorkflow(name: string) {
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    setSaveError(undefined);
    try {
      const result = await api.workflow(name);
      setCurrent({ spec: result.workflow, source: result.source });
      setSelectedId(result.workflow.nodes[0]?.id ?? result.workflow.synthesizer.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow not found");
    } finally {
      setLoading(false);
    }
  }

  function patchSpec(updater: (spec: WorkflowSpec) => WorkflowSpec) {
    setCurrent(previous => (previous ? { ...previous, spec: updater(previous.spec) } : previous));
    setSaveError(undefined);
  }

  function updateStep(id: string, changes: Record<string, unknown>) {
    patchSpec(spec => ({
      ...spec,
      nodes: spec.nodes.map(step =>
        step.id === id ? ({ ...step, ...changes } as WorkflowSpec["nodes"][number]) : step
      ),
      verifiers: spec.verifiers.map(step =>
        step.id === id ? ({ ...step, ...changes } as WorkflowSpec["verifiers"][number]) : step
      ),
      synthesizer:
        spec.synthesizer.id === id
          ? ({ ...spec.synthesizer, ...changes } as WorkflowSpec["synthesizer"])
          : spec.synthesizer
    }));
  }

  function connectSteps(source: string, target: string) {
    patchSpec(spec => {
      const addNeed = (needs: string[]) => (needs.includes(source) ? needs : [...needs, source]);
      return {
        ...spec,
        nodes: spec.nodes.map(step => (step.id === target ? { ...step, needs: addNeed(step.needs) } : step)),
        verifiers: spec.verifiers.map(step =>
          step.id === target ? { ...step, needs: addNeed(step.needs) } : step
        ),
        synthesizer:
          spec.synthesizer.id === target
            ? { ...spec.synthesizer, needs: addNeed(spec.synthesizer.needs) }
            : spec.synthesizer
      };
    });
  }

  function addNode() {
    const id = `step-${stepsOf(current!.spec).length + 1}`;
    patchSpec(spec => ({
      ...spec,
      nodes: [
        ...spec.nodes,
        {
          id,
          uses: "engine.security",
          timeoutMs: 60_000,
          continueOnError: false,
          needs: [],
          with: {}
        }
      ]
    }));
    setSelectedId(id);
  }

  function removeStep(id: string) {
    patchSpec(spec => {
      const without = (needs: string[]) => needs.filter(need => need !== id);
      return {
        ...spec,
        nodes: spec.nodes
          .filter(step => step.id !== id)
          .map(step => ({ ...step, needs: without(step.needs) })),
        verifiers: spec.verifiers
          .filter(step => step.id !== id)
          .map(step => ({ ...step, needs: without(step.needs) })),
        synthesizer: { ...spec.synthesizer, needs: without(spec.synthesizer.needs) }
      };
    });
    setSelectedId(undefined);
  }

  const selectedStep = current ? stepsOf(current.spec).find(i => i.step.id === selectedId) : undefined;
  const issues = current ? collectWorkflowGraphIssues(current.spec) : [];

  async function handleSave() {
    if (!current) return;
    setSaving(true);
    setSaveError(undefined);
    setNotice(undefined);
    try {
      const saved = await api.saveWorkflow(current.spec);
      setCurrent({ spec: saved.workflow, source: saved.source });
      setNotice(zh ? "工作流定义已成功保存为草稿。" : "Workflow draft saved.");
      await loadList();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save workflow");
    } finally {
      setSaving(false);
    }
  }

  const workflowTabs: TabItem[] = [
    { id: "definition", label: "工作流定义 (DAG Builder)", icon: <GitFork size={14} /> },
    { id: "triggers", label: "触发器与策略 (Triggers)", count: automations.length || undefined, icon: <CalendarClock size={14} /> }
  ];

  return (
    <div style={{ padding: "24px 32px", maxWidth: "1280px", margin: "0 auto" }}>
      <SectionHeader
        title="工作流与触发器 (Workflows)"
        subtitle="定义多阶段代码审查 DAG 图、分析器拓扑与自动化触发策略"
      />

      <div style={{ marginBottom: "20px" }}>
        <Tabs
          tabs={workflowTabs}
          activeId={activeTab}
          onChange={id => {
            setSearchParams(id === "triggers" ? { tab: "triggers" } : {});
          }}
        />
      </div>

      {activeTab === "triggers" ? (
        <WorkflowTriggersView
          automations={automations}
          repositories={repositories}
          capabilities={capabilities}
          actionError={actionError}
          changingAutomationId={changingAutomationId}
          onSetEnabled={onSetEnabled}
          zh={zh}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Top Bar: workflow selector + actions */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--ds-radius-md)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>选择工作流:</span>
              <Select
                sizeVariant="sm"
                value={current?.spec.name ?? ""}
                onChange={e => void openWorkflow(e.target.value)}
                options={summaries.map(s => ({
                  label: `${s.name} (${s.source === "builtin" ? "内置" : "草稿"})`,
                  value: s.name
                }))}
              />
              {current && (
                <Badge variant={current.source === "builtin" ? "neutral" : "primary"} size="sm">
                  {current.source === "builtin" ? "内置规范" : "自定义草稿"}
                </Badge>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Button variant="outline" size="sm" icon={<Plus size={13} />} onClick={addNode}>
                添加分析节点
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Save size={13} />}
                loading={saving}
                disabled={saving || !current || issues.length > 0}
                onClick={() => void handleSave()}
              >
                保存工作流草稿
              </Button>
            </div>
          </div>

          {notice && (
            <div style={{ padding: "10px 14px", background: "var(--success-soft)", color: "var(--success-strong)", borderRadius: "var(--ds-radius-md)", fontSize: "13px" }}>
              {notice}
            </div>
          )}

          {saveError && (
            <div style={{ padding: "10px 14px", background: "var(--danger-soft)", color: "var(--danger-strong)", borderRadius: "var(--ds-radius-md)", fontSize: "13px" }}>
              {saveError}
            </div>
          )}

          {/* Graph + Inspector Area */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "16px", minHeight: "520px" }}>
            {/* Graph Visualizer */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                overflow: "hidden",
                height: "560px"
              }}
            >
              {current ? (
                <WorkflowGraph
                  spec={current.spec}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onConnectSteps={connectSteps}
                />
              ) : (
                <EmptyState title="正在加载工作流拓扑..." />
              )}
            </div>

            {/* Step Editor Drawer */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--ds-radius-md)",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                overflowY: "auto",
                maxHeight: "560px"
              }}
            >
              <SectionHeader title={selectedStep ? `编辑节点: ${selectedStep.step.id}` : "节点属性"} />

              {selectedStep ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>
                      节点类型 (Role)
                    </label>
                    <Badge variant="primary" size="sm">
                      {selectedStep.role.toUpperCase()}
                    </Badge>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>
                      执行分析器 (Uses)
                    </label>
                    {"uses" in selectedStep.step ? (
                      <Select
                        sizeVariant="sm"
                        value={selectedStep.step.uses}
                        onChange={e => updateStep(selectedStep.step.id, { uses: e.target.value })}
                        options={
                          selectedStep.role === "node"
                            ? ANALYZER_KINDS.map(k => ({ label: k, value: k }))
                            : VERIFIER_KINDS.map(k => ({ label: k, value: k }))
                        }
                      />
                    ) : (
                      <span style={{ fontFamily: "var(--ds-font-mono)", fontSize: "12px" }}>
                        {(selectedStep.step as any).uses ?? "synthesizer.default"}
                      </span>
                    )}
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>
                      超时设置 (毫秒)
                    </label>
                    <Input
                      type="number"
                      sizeVariant="sm"
                      value={selectedStep.step.timeoutMs}
                      onChange={e => updateStep(selectedStep.step.id, { timeoutMs: Number(e.target.value) })}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>
                      依赖的前置节点 (Needs)
                    </label>
                    <div style={{ fontSize: "12px", fontFamily: "var(--ds-font-mono)" }}>
                      {selectedStep.step.needs.length > 0
                        ? selectedStep.step.needs.join(", ")
                        : "无前置依赖 (首批执行)"}
                    </div>
                  </div>

                  {selectedStep.role !== "synthesizer" && (
                    <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--border)" }}>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 size={13} />}
                        onClick={() => removeStep(selectedStep.step.id)}
                      >
                        删除此节点
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ color: "var(--muted)", fontSize: "13px", textAlign: "center", padding: "24px 0" }}>
                  在左侧拓扑图中点击节点以查看或修改配置
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
