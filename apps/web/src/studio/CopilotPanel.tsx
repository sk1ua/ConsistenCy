import { useState } from "react";
import { Check, LoaderCircle, RotateCcw, Sparkles, X } from "lucide-react";
import type { WorkflowRuntimeCopilotPatchOperation } from "@consistency/schema";
import { ApiRequestError } from "../api/client";
import { useI18n } from "../i18n";

export const RUNTIME_COPILOT_I18N_KEYS = [
  "Workflow Copilot",
  "Copilot instruction",
  "Describe the change in your own words; every edit still goes through Apply, validate, and save",
  "Send message",
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
  "Discard",
  "Add a node before requesting a proposal",
  "Fork before applying a proposal to a builtin seed",
  "Copilot proposal",
  "The draft changed; regenerate this proposal",
  "Applied",
  "Undo",
  "Nothing to undo",
  "Applied edits roll back one step; gates re-run afterwards"
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
 * Honest error-code mapping for the conversational copilot endpoint. Every
 * code the API can return has explicit copy; unknown codes fall back to the
 * sanitized server message instead of pretending success or guessing a reason.
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

/** View model for one conversation turn; all gating truth is computed by the
 *  parent Studio (staleness, fork guard, busy state) — the panel is dumb. */
export type CopilotTurnView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  patch: WorkflowRuntimeCopilotPatchOperation[];
  /** applied | stale | ready | plain (plain = conversational, no patch). */
  status: "applied" | "stale" | "ready" | "plain";
  applyBlockedReason: string;
};

export type CopilotPanelProps = {
  /** Any in-flight studio operation disables panel actions (shared discipline). */
  busy: boolean;
  /** The definition schema requires at least one node; an empty draft cannot be sent. */
  canSubmit: boolean;
  submitBlockedReason: string;
  turns: CopilotTurnView[];
  error: unknown;
  /** Transient honest status line. */
  status: string;
  canUndo: boolean;
  onSubmit: (instruction: string) => void;
  onApply: (turnId: string) => void;
  onDiscard: (turnId: string) => void;
  onUndo: () => void;
};

/**
 * Conversational Workflow Copilot panel (right column). The conversation is
 * client-held and sent per turn to POST /workflow-runtime/copilot/chat.
 *
 * Honesty contract:
 * - Each assistant turn renders its reply and, when present, the patch as an
 *   operation list. The panel never mutates the draft and never talks to the
 *   runtime itself.
 * - Apply is executed by the parent Studio: the patch is translated into
 *   existing reducer actions (add-node / remove-node / connect / disconnect /
 *   update-params) and then flows through the canonical validate →
 *   save-revision gate chain. There is no compiler bypass.
 * - A turn whose basis draft changed (manual edit, another Apply, Undo) is
 *   marked stale and honestly refuses Apply instead of guessing.
 */
export function CopilotPanel({ busy, canSubmit, submitBlockedReason, turns, error, status, canUndo, onSubmit, onApply, onDiscard, onUndo }: CopilotPanelProps) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const message = error ? copilotErrorMessage(error, t) : "";
  return <section className="studio-copilot" aria-label={t("Workflow Copilot")}>
    <span className="studio-copilot-title"><Sparkles size={14} /> {t("Workflow Copilot")}</span>
    {turns.length > 0 && <div className="studio-copilot-turns" role="list" aria-label={t("Copilot proposal")}>
      {turns.map(turn => <div key={turn.id} role="listitem" className={`studio-copilot-turn is-${turn.role}${turn.patch.length > 0 ? " has-patch" : ""}`}>
        <p className="studio-copilot-content">{turn.content}</p>
        {turn.role === "assistant" && turn.patch.length > 0 && <div className="studio-copilot-proposal" role="group" aria-label={t("Proposed patch")}>
          <ul className="studio-copilot-ops">
            {turn.patch.map((operation, index) => <li key={`${turn.id}-${operation.op}-${index}`}>
              <strong>{operation.op}</strong>
              {operation.op === "ADD_NODE"
                ? <><code>{operation.nodeId}</code><span>{operation.serviceRef}</span>{operation.name ? <span>{operation.name}</span> : null}</>
                : operation.op === "ADD_EDGE" || operation.op === "REMOVE_EDGE"
                  ? <code>{operation.from} → {operation.to}</code>
                  : <code>{operation.nodeId}</code>}
            </li>)}
          </ul>
          {turn.status === "applied" ? <small className="studio-copilot-hint">{t("Applied")}</small> : <>
            <small className="studio-copilot-hint">{t("Preview only; the draft is unchanged until you Apply")}</small>
            {turn.status === "stale" && <small className="studio-copilot-hint is-stale">{t("The draft changed; regenerate this proposal")}</small>}
            <div className="studio-copilot-actions">
              <button
                type="button"
                className="primary-button btn-small studio-copilot-apply"
                disabled={busy || turn.status !== "ready" || turn.applyBlockedReason.length > 0}
                title={turn.status === "stale"
                  ? t("The draft changed; regenerate this proposal")
                  : turn.applyBlockedReason || undefined}
                onClick={() => onApply(turn.id)}
              ><Check size={13} />{t("Apply")}</button>
              <button
                type="button"
                className="secondary-button btn-small studio-copilot-reject"
                disabled={busy}
                onClick={() => onDiscard(turn.id)}
              ><X size={13} />{t("Discard")}</button>
            </div>
          </>}
        </div>}
      </div>)}
    </div>}
    <textarea
      aria-label={t("Copilot instruction")}
      placeholder={t("Describe the change in your own words; every edit still goes through Apply, validate, and save")}
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
        {busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}{t("Send message")}
      </button>
      <button
        type="button"
        className="secondary-button btn-small studio-copilot-undo"
        disabled={busy || !canUndo}
        title={canUndo ? t("Applied edits roll back one step; gates re-run afterwards") : t("Nothing to undo")}
        onClick={onUndo}
      ><RotateCcw size={13} />{t("Undo")}</button>
      {!canSubmit && <small className="studio-copilot-status">{submitBlockedReason}</small>}
    </div>
    {message && <div className="studio-copilot-note" role="alert">{message}</div>}
    {!message && status && <small className="studio-copilot-status" role="status">{status}</small>}
  </section>;
}
