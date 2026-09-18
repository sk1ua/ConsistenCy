import type { ReviewFinding } from "@consistency/schema";
import { ChevronDown, FileCode2 } from "lucide-react";
import { useId, useState } from "react";
import type { FindingClientDisposition } from "../utils/findingDisposition";
import { StatusBadge } from "./StatusBadge";
import { useI18n } from "../i18n";
import { Dialog } from "../design-system/Dialog";
import { api, ApiRequestError } from "../api/client";
import type { FindingPatchPreviewResponse } from "@consistency/schema";

export function FindingItem({
  finding,
  onLocate,
  disposition,
  onDispositionChange,
  jobId,
  accessMode
}: {
  finding: ReviewFinding;
  onLocate?: (file: string, line: number | undefined) => void;
  disposition?: FindingClientDisposition | null;
  onDispositionChange?: (disposition: FindingClientDisposition | null) => void;
  /** When set with a suggestedPatch, enables server-backed preview / apply. */
  jobId?: string;
  accessMode?: "github_app" | "public_read" | "local_git";
}) {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const [expanded, setExpanded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<FindingPatchPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const detailId = useId();
  const summaryId = `${detailId}-summary`;
  const line = finding.startLine === undefined
    ? t("File-level")
    : finding.startLine === finding.endLine ? `L${finding.startLine}` : `L${finding.startLine}-${finding.endLine}`;
  const muted = disposition === "dismissed" || disposition === "accepted";
  const className = [
    "finding-item",
    disposition === "dismissed" ? "finding-item--dismissed" : "",
    disposition === "accepted" ? "finding-item--accepted" : ""
  ].filter(Boolean).join(" ");
  const hasPatch = Boolean(finding.suggestedPatch?.trim());

  async function openPreview() {
    if (!hasPatch) return;
    setPreviewOpen(true);
    setApplyMessage(null);
    setApplyError(null);
    if (!jobId) {
      setPreview({
        jobId: "",
        findingId: finding.id,
        accessMode: accessMode ?? "github_app",
        patch: finding.suggestedPatch as string,
        touchedPaths: [finding.file],
        applyAvailable: false,
        applyUnavailableReason: zh
          ? "缺少审查任务上下文，无法校验或应用补丁。"
          : "Job context is missing; cannot verify or apply the patch.",
        verification: { policyOk: true, violations: [] }
      });
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await api.findingPatchPreview(jobId, finding.id);
      setPreview(result);
    } catch (error) {
      // Fall back to the embedded suggestion so preview still works offline of verify.
      setPreview({
        jobId,
        findingId: finding.id,
        accessMode: accessMode ?? "github_app",
        patch: finding.suggestedPatch as string,
        touchedPaths: [finding.file],
        applyAvailable: false,
        applyUnavailableReason: error instanceof ApiRequestError
          ? error.message
          : (zh ? "无法从服务器加载补丁预览。" : "Could not load patch preview from the server."),
        verification: { policyOk: true, violations: [] }
      });
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function applyPatch() {
    if (!jobId || !preview?.applyAvailable) return;
    setApplyBusy(true);
    setApplyError(null);
    setApplyMessage(null);
    try {
      const result = await api.findingPatchApply(jobId, finding.id);
      setApplyMessage(zh
        ? `已应用到工作区（未暂存、未提交）：${result.touchedPaths.join(", ")}`
        : `Applied to working tree (unstaged, not committed): ${result.touchedPaths.join(", ")}`);
      setPreview(current => current ? { ...current, applyAvailable: false, applyUnavailableReason: zh ? "补丁已应用到工作区" : "Patch already applied to the working tree" } : current);
    } catch (error) {
      setApplyError(error instanceof ApiRequestError
        ? error.message
        : (error instanceof Error ? error.message : String(error)));
    } finally {
      setApplyBusy(false);
    }
  }

  return (
    <article className={className} data-disposition={disposition ?? "none"}>
      <div className="finding-summary-row">
        <button
          id={summaryId}
          className="finding-summary"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded(value => !value)}
        >
          <FileCode2 size={17} />
          <span className="finding-title">
            <strong>{finding.title}</strong>
            {onLocate ? null : <small>{finding.file} / {line}</small>}
          </span>
          <span className="finding-badges">
            <StatusBadge value={finding.severity} />
            <StatusBadge value={finding.confidence} />
            {disposition === "dismissed" ? <span className="finding-disposition-pill">{t("Dismissed")}</span> : null}
            {disposition === "accepted" ? <span className="finding-disposition-pill finding-disposition-pill--accepted">{t("Accepted")}</span> : null}
            {hasPatch ? <span className="finding-disposition-pill finding-disposition-pill--patch">{t("Has patch")}</span> : null}
          </span>
          <ChevronDown className={expanded ? "rotated" : ""} size={17} />
        </button>
        {onLocate ? <button
          className="finding-locate"
          type="button"
          aria-label={`${finding.title}: ${finding.file} / ${line}`}
          onClick={() => onLocate(finding.file, finding.startLine)}
        >{finding.file} / {line}</button> : null}
      </div>
      {onDispositionChange || hasPatch ? (
        <div className="finding-disposition-actions" role="group" aria-label={t("Finding disposition")}>
          {onDispositionChange ? (
            <>
              {disposition !== "accepted" ? (
                <button
                  type="button"
                  className="finding-disposition-btn"
                  onClick={() => onDispositionChange("accepted")}
                >{t("Accept")}</button>
              ) : (
                <button
                  type="button"
                  className="finding-disposition-btn"
                  onClick={() => onDispositionChange(null)}
                >{t("Undo accept")}</button>
              )}
              {disposition !== "dismissed" ? (
                <button
                  type="button"
                  className="finding-disposition-btn"
                  onClick={() => onDispositionChange("dismissed")}
                >{t("Dismiss")}</button>
              ) : (
                <button
                  type="button"
                  className="finding-disposition-btn"
                  onClick={() => onDispositionChange(null)}
                >{t("Undo dismiss")}</button>
              )}
            </>
          ) : null}
          {hasPatch ? (
            <button
              type="button"
              className="finding-disposition-btn finding-patch-preview-btn"
              onClick={() => void openPreview()}
            >{t("Preview patch")}</button>
          ) : null}
        </div>
      ) : null}
      {expanded && (
        <div id={detailId} className="finding-detail" role="region" aria-labelledby={summaryId} data-muted={muted ? "true" : undefined}>
          <div><span>{t("Evidence")}</span><p>{finding.evidence}</p></div>
          <div><span>{t("Reasoning")}</span><p>{finding.reasoning}</p></div>
          <div><span>{t("Recommendation")}</span><p>{finding.recommendation}</p></div>
          {finding.suggestedPatch && (
            <div className="finding-patch-teaser">
              <span>{t("Suggested patch")}</span>
              <button type="button" className="text-link" onClick={() => void openPreview()}>
                {t("Preview patch")}
              </button>
            </div>
          )}
        </div>
      )}

      <Dialog
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t("Patch preview")}
        description={zh
          ? "只读统一差异预览；应用仅针对已注册的 local_git 工作区，且不会提交。"
          : "Read-only unified diff. Apply is local_git only and never commits."}
        className="finding-patch-dialog"
        footer={
          <div className="finding-patch-dialog-footer">
            {preview?.applyAvailable ? (
              <button
                type="button"
                className="finding-disposition-btn finding-patch-apply-btn"
                disabled={applyBusy}
                onClick={() => void applyPatch()}
              >{applyBusy ? t("Applying…") : t("Apply to working tree")}</button>
            ) : (
              <button
                type="button"
                className="finding-disposition-btn finding-patch-apply-btn"
                disabled
                title={preview?.applyUnavailableReason ?? (zh ? "当前不可应用" : "Apply unavailable")}
              >{t("Apply to working tree")}</button>
            )}
            <button type="button" className="finding-disposition-btn" onClick={() => setPreviewOpen(false)}>
              {t("Close")}
            </button>
          </div>
        }
      >
        {previewLoading ? (
          <p className="finding-patch-status">{zh ? "正在校验补丁…" : "Verifying patch…"}</p>
        ) : null}
        {previewError ? <p className="finding-patch-status finding-patch-status--warn" role="status">{previewError}</p> : null}
        {preview && !preview.applyAvailable && preview.applyUnavailableReason ? (
          <p className="finding-patch-status finding-patch-status--muted" role="status">
            {zh ? "应用不可用：" : "Apply unavailable: "}{preview.applyUnavailableReason}
          </p>
        ) : null}
        {preview?.verification.applies === true ? (
          <p className="finding-patch-status finding-patch-status--ok" role="status">
            {zh ? "补丁可干净应用到当前工作区。" : "Patch applies cleanly to the current working tree."}
          </p>
        ) : null}
        {preview?.verification.violations?.length ? (
          <ul className="finding-patch-violations">
            {preview.verification.violations.map((violation, index) => (
              <li key={`${violation.code}-${index}`}>{violation.message}</li>
            ))}
          </ul>
        ) : null}
        {applyMessage ? <p className="finding-patch-status finding-patch-status--ok" role="status">{applyMessage}</p> : null}
        {applyError ? <p className="finding-patch-status finding-patch-status--error" role="alert">{applyError}</p> : null}
        <pre className="finding-patch-diff" tabIndex={0}>{preview?.patch ?? finding.suggestedPatch}</pre>
      </Dialog>
    </article>
  );
}
