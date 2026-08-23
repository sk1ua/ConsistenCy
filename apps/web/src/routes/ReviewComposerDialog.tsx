import { useEffect, useRef, useMemo, useState } from "react";
import type {
  LocalReviewRequest,
  ReviewModelOverride,
  ReviewPreparationResponse
} from "@consistency/schema";
import { ArrowRight, CircleAlert, GitBranch, Loader2, PlayCircle } from "lucide-react";
import { Button } from "../design-system/Button";
import { Dialog } from "../design-system/Dialog";
import { Input } from "../design-system/Input";

type ReviewSource = "working-tree" | "branch";

export type ReviewComposerDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  displayName: string;
  repositoryId: string;
  preparation?: ReviewPreparationResponse;
  pending: boolean;
  onSubmit: (request: LocalReviewRequest) => void;
  zh: boolean;
  onConfigureModel: () => void;
  error?: string | null;
  onClearError?: () => void;
};

export type ReviewSubmissionGate = {
  tryAcquire: () => boolean;
  reset: () => void;
};

export function createReviewSubmissionGate(): ReviewSubmissionGate {
  let acquired = false;
  return {
    tryAcquire: () => {
      if (acquired) return false;
      acquired = true;
      return true;
    },
    reset: () => {
      acquired = false;
    }
  };
}

type ReviewComposerValidationInput = {
  preparation: ReviewPreparationResponse;
  provider: "deepseek" | "openai";
  model: string;
  useGlobalDefault: boolean;
  zh: boolean;
};

function providerLabel(provider: "deepseek" | "openai"): string {
  return provider === "deepseek" ? "DeepSeek" : "OpenAI";
}

export function buildLocalReviewRequest(
  repositoryId: string,
  source: ReviewSource,
  preparation: ReviewPreparationResponse,
  useGlobalDefault: boolean,
  customProvider: "deepseek" | "openai",
  customModel: string
): LocalReviewRequest {
  const request: LocalReviewRequest = { repositoryId };
  if (source === "branch") {
    request.baseRef = preparation.sources.branch.base;
    request.headRef = preparation.sources.branch.head;
  }
  if (!useGlobalDefault) {
    const model: ReviewModelOverride = { provider: customProvider, model: customModel.trim() };
    request.model = model;
  }
  return request;
}

export function getReviewComposerValidationMessage({
  preparation,
  provider,
  model,
  useGlobalDefault,
  zh
}: ReviewComposerValidationInput): string | null {
  if (useGlobalDefault) return null;
  if (!preparation.model.providers[provider].configured) {
    return zh ? "该提供商尚未配置。" : "That provider is not configured.";
  }
  if (model.trim().length === 0) {
    return zh ? "请输入模型名称。" : "Enter a model name.";
  }
  return null;
}

export function calculateDialogTransition(wasOpen: boolean, isOpen: boolean): { shouldInitialize: boolean; nextWasOpen: boolean } {
  return {
    shouldInitialize: isOpen && !wasOpen,
    nextWasOpen: isOpen
  };
}

export function ReviewComposerDialog({
  isOpen,
  onClose,
  displayName,
  repositoryId,
  preparation,
  pending,
  onSubmit,
  zh,
  onConfigureModel,
  error,
  onClearError
}: ReviewComposerDialogProps) {
  const defaultSource: ReviewSource = preparation?.sources.workingTree.available
    ? "working-tree"
    : "branch";
  const [source, setSource] = useState<ReviewSource>(defaultSource);
  const [useGlobalDefault, setUseGlobalDefault] = useState(true);
  const [customProvider, setCustomProvider] = useState<"deepseek" | "openai">("deepseek");
  const [customModel, setCustomModel] = useState("");

  const configuredProviders = useMemo(() => {
    if (!preparation) return [] as Array<"deepseek" | "openai">;
    return (["deepseek", "openai"] as const).filter(provider => preparation.model.providers[provider].configured);
  }, [preparation]);

  const submissionGate = useState(createReviewSubmissionGate)[0];
  const wasOpen = useRef(false);

  useEffect(() => {
    const { shouldInitialize, nextWasOpen } = calculateDialogTransition(wasOpen.current, isOpen);

    if (shouldInitialize) {
      submissionGate.reset();
      onClearError?.();

      if (preparation) {
        const nextSource = preparation.sources.workingTree.available
          ? "working-tree"
          : preparation.sources.branch.available ? "branch" : "working-tree";
        setSource(nextSource);

        const firstConfigured = (["deepseek", "openai"] as const).find(provider => preparation.model.providers[provider].configured);
        if (firstConfigured) {
          setCustomProvider(firstConfigured);
          setCustomModel(preparation.model.providers[firstConfigured].defaultModel ?? "");
        }
        setUseGlobalDefault(true);
      }
    }
    wasOpen.current = nextWasOpen;
  }, [isOpen, onClearError, submissionGate, preparation]);

  useEffect(() => {
    if (!pending && error) {
      submissionGate.reset();
    }
  }, [pending, error, submissionGate]);

  const handleClose = () => {
    if (pending) return;
    onClearError?.();
    onClose();
  };

  const handleConfigureModel = () => {
    if (pending) return;
    onConfigureModel();
  };

  const hasLlm = Boolean(preparation && preparation.model.default.provider !== "none");
  const pendingRestart = preparation?.model.pendingRestart;
  const sourceAvailable = source === "working-tree"
    ? preparation?.sources.workingTree.available === true
    : preparation?.sources.branch.available === true;
  const customModelValid = customModel.trim().length > 0 && configuredProviders.includes(customProvider);
  const canSubmit = preparation?.canStartReview === true && sourceAvailable && (useGlobalDefault || customModelValid) && !pending;
  const customValidationMessage = preparation
    ? getReviewComposerValidationMessage({ preparation, provider: customProvider, model: customModel, useGlobalDefault, zh })
    : null;

  const handleChangeSource = (s: ReviewSource) => {
    setSource(s);
    onClearError?.();
  };
  const handleChangeGlobal = (g: boolean) => {
    setUseGlobalDefault(g);
    onClearError?.();
  };
  const handleChangeProvider = (p: "deepseek" | "openai") => {
    setCustomProvider(p);
    setCustomModel(preparation?.model.providers[p].defaultModel ?? "");
    onClearError?.();
  };
  const handleChangeModel = (m: string) => {
    setCustomModel(m);
    onClearError?.();
  };

  const handleSubmit = () => {
    if (!preparation || !canSubmit || !submissionGate.tryAcquire()) return;
    onClearError?.();
    onSubmit(buildLocalReviewRequest(repositoryId, source, preparation, useGlobalDefault, customProvider, customModel));
  };
  const defaultProvider = preparation?.model.default.provider;
  const defaultModel = preparation?.model.default.model;
  const sourceReason = source === "working-tree"
    ? preparation?.sources.workingTree.reason
    : preparation?.sources.branch.reason;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      dismissible={!pending}
      title={zh ? "审查代码" : "Start Review"}
      description={zh ? `为 ${displayName} 发起一次代码质量与安全性审查` : `Start a code quality and security review for ${displayName}`}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", fontSize: "12px" }}>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: "8px" }}>{zh ? "来源" : "Source"}</legend>
          <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 0", opacity: preparation?.sources.workingTree.available ? 1 : 0.55 }}>
            <input
              type="radio"
              name="review-source"
              checked={source === "working-tree"}
               disabled={pending || !preparation?.sources.workingTree.available}
              onChange={() => handleChangeSource("working-tree")}
            />
            <span>
              <strong>{zh ? "工作区变更" : "Working tree changes"}</strong>
              <br />
              <span style={{ color: "var(--muted)" }}>
                {preparation?.sources.workingTree.available
                  ? `${preparation.sources.workingTree.changedFileCount} ${zh ? "个文件" : "files"}`
                  : preparation?.sources.workingTree.reason ?? (zh ? "不可用" : "Unavailable")}
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 0", opacity: preparation?.sources.branch.available ? 1 : 0.55 }}>
            <input
              type="radio"
              name="review-source"
              checked={source === "branch"}
               disabled={pending || !preparation?.sources.branch.available}
              onChange={() => handleChangeSource("branch")}
            />
            <span>
              <strong>{zh ? "分支差异" : "Branch diff"}</strong>
              <br />
              <span style={{ color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <GitBranch size={11} />
                {preparation?.sources.branch.available
                  ? <>{preparation.sources.branch.head} <ArrowRight size={11} /> {preparation.sources.branch.base}</>
                  : preparation?.sources.branch.reason ?? (zh ? "不可用" : "Unavailable")}
              </span>
            </span>
          </label>
          {sourceReason && sourceAvailable === false && <div style={{ color: "var(--warning-strong)", marginTop: "4px" }}>{sourceReason}</div>}
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: "8px" }}>{zh ? "模型" : "Model"}</legend>
          {!preparation ? (
            <span style={{ color: "var(--muted)" }}>{zh ? "正在读取审查准备状态..." : "Loading review preparation..."}</span>
          ) : hasLlm ? (
            <>
              <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 0" }}>
                <input type="radio" name="review-model" checked={useGlobalDefault} disabled={pending} onChange={() => handleChangeGlobal(true)} />
                <span>
                  <strong>{zh ? "使用全局默认" : "Use global default"}</strong>
                  <br />
                  <span style={{ color: "var(--muted)" }}>{providerLabel(defaultProvider as "deepseek" | "openai")} · {defaultModel}</span>
                </span>
              </label>
              <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 0" }}>
                <input type="radio" name="review-model" checked={!useGlobalDefault} disabled={pending} onChange={() => handleChangeGlobal(false)} />
                <span><strong>{zh ? "本次审查使用其他模型" : "Use another model for this review"}</strong></span>
              </label>
              {!useGlobalDefault && (
                <div style={{ display: "grid", gap: "8px", margin: "4px 0 0 24px" }}>
                  <label>
                    <span style={{ display: "block", color: "var(--muted)", marginBottom: "4px" }}>{zh ? "提供商" : "Provider"}</span>
                    <select className="ds-input ds-select" value={customProvider} onChange={event => handleChangeProvider(event.target.value as "deepseek" | "openai")} disabled={pending || configuredProviders.length === 0}>
                      {(["deepseek", "openai"] as const).map(provider => (
                        <option key={provider} value={provider} disabled={!preparation?.model.providers[provider].configured}>
                          {providerLabel(provider)}{preparation?.model.providers[provider].configured ? "" : ` (${zh ? "未配置" : "Not configured"})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span style={{ display: "block", color: "var(--muted)", marginBottom: "4px" }}>{zh ? "模型" : "Model"}</span>
                    <Input value={customModel} onChange={event => handleChangeModel(event.target.value)} disabled={pending} aria-invalid={customValidationMessage !== null} />
                  </label>
                  {customValidationMessage && <span role="alert" style={{ color: "var(--warning-strong)" }}>{customValidationMessage}</span>}
                  <span style={{ color: "var(--muted)" }}>{zh ? "仅对本次审查生效，不修改全局设置。" : "Applies only to this review; global settings are unchanged."}</span>
                </div>
              )}
            </>
          ) : pendingRestart ? (
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", color: "var(--warning-strong)" }}>
              <CircleAlert size={15} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span><strong>{providerLabel(pendingRestart.provider)}</strong> &middot; {pendingRestart.model}</span>
                <span>{zh ? "配置已保存，需重启后端服务后生效。" : "Configuration saved. Restart the API to apply."}</span>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", color: "var(--warning-strong)" }}>
              <CircleAlert size={15} />
              <span>{zh ? "尚未配置大语言模型。请先配置 DeepSeek 或 OpenAI。" : "No language model is configured. Configure DeepSeek or OpenAI before running a review."}</span>
            </div>
          )}
        </fieldset>


        {error && (
          <div role="alert" style={{ display: "flex", gap: "8px", alignItems: "flex-start", color: "var(--danger-strong)", backgroundColor: "var(--danger-soft)", padding: "8px 12px", borderRadius: "var(--ds-radius-md)" }}>
            <CircleAlert size={15} style={{ flexShrink: 0, marginTop: "2px" }} />
            <span>{error}</span>
          </div>
        )}
        {preparation?.blockingReasons
          .filter(reason => !reason.includes("尚未配置大语言模型") && !reason.includes("LLM provider is not configured") && !reason.includes("重启 API 后生效"))
          .map(reason => <div key={reason} style={{ color: "var(--warning-strong)" }}>{reason}</div>)}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
          <Button variant="outline" size="sm" onClick={handleClose} disabled={pending}>{zh ? "取消" : "Cancel"}</Button>
          {!preparation ? null : !hasLlm ? (
            <Button variant="primary" size="sm" onClick={handleConfigureModel} disabled={pending}>{pendingRestart ? (zh ? "查看设置" : "View settings") : (zh ? "配置模型" : "Configure model")}</Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={pending ? <Loader2 size={12} className="ds-spin" /> : <PlayCircle size={12} />}
              disabled={!canSubmit}
              loading={pending}
              onClick={handleSubmit}
            >
              {zh ? "审查代码" : "Start Review"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
