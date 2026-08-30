import { useState } from "react";
import { Check, LoaderCircle, Sparkles, X } from "lucide-react";
import type { WorkflowRuntimeCopilotProposal } from "@consistency/schema";
import { ApiRequestError } from "../api/client";
import { useI18n } from "../i18n";

export const RUNTIME_COPILOT_I18N_KEYS = [
  "Workflow Copilot",
  "Copilot instruction",
  "Describe the workflow change; the Copilot only proposes a patch and never edits the runtime",
  "Propose patch",
  "Copilot proposal failed",
  "LLM is not configured; configure DeepSeek or OpenAI to generate proposals",
  "The selected LLM provider is not configured; configure its API key first",
  "The configured review model is invalid",
  "The proposal failed server validation",
  "The LLM could not produce a schema-valid proposal; try again",
  "Definition not found",
  "Workflow runtime is unavailable",
  "Proposed patch",
  "Preview only; the draft is unchanged until you Apply",
  "Apply",
  "Reject",
  "Add a node before requesting a proposal",
  "Fork before applying a proposal to a builtin seed",
  "Copilot proposal",
  "Preview discarded; the draft changed"
] as const;

type CopilotErrorIssue = { message?: unknown };

function copilotIssueSummary(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return "";
  const issues = error.details?.issues;
  if (!Array.isArray(issues)) return "";
  return issues
    .map(issue => typeof (issue as CopilotErrorIssue)?.message === "string" ? (issue as CopilotErrorIssue).message as string : "")
    .filter(Boolean)
    .slice(0, 3)
    .join("; ");
}

/**
 * Honest error-code mapping for the copilot proposal endpoint. Every code the
 * API can return has explicit copy; unknown codes fall back to the sanitized
 * server message instead of pretending success or guessing a reason.
 */
export function copilotErrorMessage(error: unknown, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!error) return "";
  const code = error instanceof ApiRequestError ? error.code : undefined;
  switch (code) {
    case "LLM_NOT_CONFIGURED": return t("LLM is not configured; configure DeepSeek or OpenAI to generate proposals");
    case "LLM_PROVIDER_NOT_CONFIGURED": return t("The selected LLM provider is not configured; configure its API key first");
    case "INVALID_REVIEW_MODEL": return t("The configured review model is invalid");
    case "WORKFLOW_PATCH_INVALID": {
      const summary = copilotIssueSummary(error);
      return summary ? `${t("The proposal failed server validation")}: ${summary}` : t("The proposal failed server validation");
    }
    case "WORKFLOW_PATCH_GENERATION_FAILED": return t("The LLM could not produce a schema-valid proposal; try again");
    case "WORKFLOW_DEFINITION_NOT_FOUND": return t("Definition not found");
    case "WORKFLOW_RUNTIME_UNAVAILABLE": return t("Workflow runtime is unavailable");
    default: return error instanceof Error && error.message ? `${t("Copilot proposal failed")}: ${error.message}` : t("Copilot proposal failed");
  }
}

export type CopilotPanelProps = {
  /** Any in-flight studio operation disables panel actions (shared discipline). */
  busy: boolean;
  /** The definition schema requires at least one node; an empty draft cannot be sent. */
  canSubmit: boolean;
  submitBlockedReason: string;
  proposal: WorkflowRuntimeCopilotProposal | undefined;
  error: unknown;
  /** Translated reason Apply is currently refused (e.g. unforked builtin seed). */
  applyBlockedReason: string;
  /** Transient honest status line (e.g. preview discarded after a draft edit). */
  status: string;
  onSubmit: (instruction: string) => void;
  onApply: () => void;
  onReject: () => void;
};

/**
 * CKPT6 Phase 3 — Workflow Copilot panel (SPEC §18.2: the right column is NOT
 * a chat; it produces a structured WorkflowPatch proposal).
 *
 * Honesty contract:
 * - Submits one instruction to POST /workflow-runtime/copilot/proposal and
 *   renders the returned proposal as an operation list. It never mutates the
 *   draft and never talks to the runtime itself.
 * - Apply is executed by the parent Studio: the patch is translated into
 *   existing reducer actions (add-node / update-params / connect) and then
 *   flows through the canonical validate → save-revision gate chain. There is
 *   no compiler bypass.
 */
export function CopilotPanel({ busy, canSubmit, submitBlockedReason, proposal, error, applyBlockedReason, status, onSubmit, onApply, onReject }: CopilotPanelProps) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const message = error ? copilotErrorMessage(error, t) : "";
  return <section className="studio-copilot" aria-label={t("Workflow Copilot")}>
    <span className="studio-copilot-title"><Sparkles size={14} /> {t("Workflow Copilot")}</span>
    <textarea
      aria-label={t("Copilot instruction")}
      placeholder={t("Describe the workflow change; the Copilot only proposes a patch and never edits the runtime")}
      value={instruction}
      maxLength={2000}
      onChange={event => setInstruction(event.target.value)}
    />
    <div className="studio-copilot-actions">
      <button
        type="button"
        className="primary-button btn-small studio-copilot-submit"
        disabled={busy || !canSubmit || instruction.trim().length === 0}
        title={canSubmit ? undefined : submitBlockedReason}
        onClick={() => { if (instruction.trim()) onSubmit(instruction.trim()); }}
      >
        {busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}{t("Propose patch")}
      </button>
      {!canSubmit && <small className="studio-copilot-status">{submitBlockedReason}</small>}
    </div>
    {message && <div className="studio-copilot-note" role="alert">{message}</div>}
    {!message && status && <small className="studio-copilot-status" role="status">{status}</small>}
    {proposal && <div className="studio-copilot-proposal" role="group" aria-label={t("Proposed patch")}>
      <p className="studio-copilot-rationale">{proposal.rationale}</p>
      <ul className="studio-copilot-ops">
        {proposal.patch.map((operation, index) => <li key={`${operation.op}-${index}`}>
          <strong>{operation.op}</strong>
          {operation.op === "ADD_NODE"
            ? <><code>{operation.nodeId}</code><span>{operation.serviceRef}</span>{operation.name ? <span>{operation.name}</span> : null}</>
            : <code>{operation.from} → {operation.to}</code>}
        </li>)}
      </ul>
      <small className="studio-copilot-hint">{t("Preview only; the draft is unchanged until you Apply")}</small>
      <div className="studio-copilot-actions">
        <button
          type="button"
          className="primary-button btn-small studio-copilot-apply"
          disabled={busy || applyBlockedReason.length > 0}
          title={applyBlockedReason || undefined}
          onClick={onApply}
        ><Check size={13} />{t("Apply")}</button>
        <button
          type="button"
          className="secondary-button btn-small studio-copilot-reject"
          disabled={busy}
          onClick={onReject}
        ><X size={13} />{t("Reject")}</button>
      </div>
    </div>}
  </section>;
}
