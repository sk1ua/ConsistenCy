import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PlayCircle,
  FolderGit2,
  GitBranch,
  Github,
  Cpu,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Info
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Dialog } from "../design-system/Dialog";
import { Button } from "../design-system/Button";
import { Badge } from "../design-system/Badge";
import { Select } from "../design-system/Select";
import { RadioGroup } from "../design-system/RadioGroup";

export interface ReviewComposerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  repositoryId: string;
}

export const ReviewComposerDialog: React.FC<ReviewComposerDialogProps> = ({
  isOpen,
  onClose,
  repositoryId
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedSource, setSelectedSource] = useState<"working_tree" | "branch" | "pr">("working_tree");
  const [useModelOverride, setUseModelOverride] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<"deepseek" | "openai">("deepseek");
  const [selectedModel, setSelectedModel] = useState("deepseek-v4-flash");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch server-owned Review Preparation DTO
  const prepQuery = useQuery({
    queryKey: ["review-preparation", repositoryId],
    queryFn: () => api.reviewPreparation(repositoryId),
    enabled: isOpen
  });

  const triggerReview = useMutation({
    mutationFn: async () => {
      const modelOverride = useModelOverride
        ? { provider: selectedProvider, model: selectedModel }
        : undefined;

      if (selectedSource === "branch" && prepQuery.data?.sources.branch.head) {
        return api.triggerLocalReview({
          repositoryId,
          baseRef: prepQuery.data.sources.branch.base || "main",
          headRef: prepQuery.data.sources.branch.head,
          model: modelOverride
        });
      }

      return api.triggerLocalReview({
        repositoryId,
        model: modelOverride
      });
    },
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      onClose();
      navigate(`/runs/${encodeURIComponent(result.jobId)}/overview`);
    },
    onError: (err: any) => {
      setErrorMessage(err.message || "发起审查失败");
    }
  });

  const prep = prepQuery.data;

  // Auto-select valid source when data loads
  React.useEffect(() => {
    if (prep) {
      if (prep.sources.workingTree.available) {
        setSelectedSource("working_tree");
      } else if (prep.sources.branch.available) {
        setSelectedSource("branch");
      }
    }
  }, [prep]);

  const sourceOptions = [
    {
      value: "working_tree",
      label: (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span>工作区未提交变更 (Working Tree)</span>
          {prep?.sources.workingTree.available ? (
            <Badge variant="success" size="sm">
              {prep.sources.workingTree.changedFileCount} 个变更文件
            </Badge>
          ) : (
            <Badge variant="neutral" size="sm">
              无变更
            </Badge>
          )}
        </div>
      ),
      description: prep?.sources.workingTree.available
        ? "审查本地工作区中已修改或新增的代码文件"
        : prep?.sources.workingTree.reason || "当前工作区干净，无未提交变更",
      disabled: !prep?.sources.workingTree.available
    },
    {
      value: "branch",
      label: (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span>当前分支差异 (Branch Diff)</span>
          {prep?.sources.branch.available ? (
            <Badge variant="primary" size="sm">
              {prep.sources.branch.head} → {prep.sources.branch.base}
            </Badge>
          ) : (
            <Badge variant="neutral" size="sm">
              不可用
            </Badge>
          )}
        </div>
      ),
      description: prep?.sources.branch.available
        ? `对比 ${prep.sources.branch.head} 与基准分支 ${prep.sources.branch.base} 的差异`
        : prep?.sources.branch.reason || "主分支无法自动对比分支差异",
      disabled: !prep?.sources.branch.available
    }
  ];

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="发起代码审查 (Start Review)"
      description={`为仓库 ${prep?.repository.displayName || repositoryId} 配置并执行一次可复现的证据审查`}
      sizeVariant="md"
      footer={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
          <Button variant="outline" onClick={onClose} disabled={triggerReview.isPending}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={triggerReview.isPending ? <Loader2 size={14} className="ds-spin" /> : <PlayCircle size={14} />}
            loading={triggerReview.isPending}
            disabled={!prep?.canStartReview || triggerReview.isPending}
            onClick={() => {
              setErrorMessage(null);
              triggerReview.mutate();
            }}
          >
            立即执行审查
          </Button>
        </div>
      }
    >
      {prepQuery.isLoading ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
          <Loader2 size={24} className="ds-spin" style={{ margin: "0 auto 8px" }} />
          <div>正在分析代码仓库审查就绪状态...</div>
        </div>
      ) : prepQuery.isError ? (
        <div style={{ padding: "16px", background: "var(--danger-soft)", color: "var(--danger-strong)", borderRadius: "var(--ds-radius-md)" }}>
          无法获取审查就绪状态: {(prepQuery.error as Error).message}
        </div>
      ) : prep ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Blocking Reasons if any */}
          {prep.blockingReasons.length > 0 && (
            <div
              style={{
                padding: "12px",
                background: "var(--warning-soft)",
                border: "1px solid var(--warning-faint)",
                borderRadius: "var(--ds-radius-md)",
                fontSize: "13px",
                color: "var(--warning-strong)",
                display: "flex",
                flexDirection: "column",
                gap: "4px"
              }}
            >
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}>
                <AlertCircle size={15} />
                <span>审查暂不可用 (Blocking Reasons)</span>
              </div>
              <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                {prep.blockingReasons.map((reason, idx) => (
                  <li key={idx}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Error from mutation if any */}
          {errorMessage && (
            <div
              style={{
                padding: "10px 12px",
                background: "var(--danger-soft)",
                color: "var(--danger-strong)",
                borderRadius: "var(--ds-radius-md)",
                fontSize: "13px"
              }}
            >
              {errorMessage}
            </div>
          )}

          {/* Source Selection */}
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
              1. 选择审查来源 (Review Source)
            </label>
            <RadioGroup
              name="review-source"
              options={sourceOptions}
              value={selectedSource}
              onChange={val => setSelectedSource(val as any)}
            />
          </div>

          {/* LLM Model Selection */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "14px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
              2. 审查大语言模型 (Review Model)
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="model-choice"
                  checked={!useModelOverride}
                  onChange={() => setUseModelOverride(false)}
                  style={{ accentColor: "var(--primary)" }}
                />
                <div>
                  <span style={{ fontWeight: !useModelOverride ? 600 : 400 }}>
                    使用全局默认配置 ({prep.model.default.provider.toUpperCase()} · {prep.model.default.model})
                  </span>
                </div>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="model-choice"
                  checked={useModelOverride}
                  onChange={() => setUseModelOverride(true)}
                  style={{ accentColor: "var(--primary)" }}
                />
                <div>
                  <span style={{ fontWeight: useModelOverride ? 600 : 400 }}>
                    为本次审查指定模型 (Per-Review Override)
                  </span>
                </div>
              </label>

              {useModelOverride && (
                <div
                  style={{
                    marginLeft: "24px",
                    padding: "10px 12px",
                    background: "var(--surface-subtle)",
                    borderRadius: "var(--ds-radius-md)",
                    display: "flex",
                    gap: "10px",
                    alignItems: "center"
                  }}
                >
                  <Select
                    sizeVariant="sm"
                    value={selectedProvider}
                    onChange={e => {
                      const p = e.target.value as "deepseek" | "openai";
                      setSelectedProvider(p);
                      setSelectedModel(p === "openai" ? "gpt-4.1-mini" : "deepseek-v4-flash");
                    }}
                    options={[
                      { label: "DeepSeek", value: "deepseek" },
                      { label: "OpenAI", value: "openai" }
                    ]}
                  />

                  <Select
                    sizeVariant="sm"
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    options={
                      selectedProvider === "deepseek"
                        ? [
                            { label: "deepseek-v4-flash (推荐)", value: "deepseek-v4-flash" },
                            { label: "deepseek-chat", value: "deepseek-chat" },
                            { label: "deepseek-reasoner", value: "deepseek-reasoner" }
                          ]
                        : [
                            { label: "gpt-4.1-mini (推荐)", value: "gpt-4.1-mini" },
                            { label: "gpt-4.1", value: "gpt-4.1" },
                            { label: "gpt-4o", value: "gpt-4o" }
                          ]
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
};
