import { CheckCircle2, Inbox, LoaderCircle, Save } from "lucide-react";
import type {
  WorkflowRuntimeDefinitionRevision,
  WorkflowRuntimeDefinitionSummary
} from "@consistency/schema";
import { Button } from "../design-system/Button";
import { Dialog } from "../design-system/Dialog";

/**
 * Edit-definition dialog for the verified runtime tab (dialog-first IA).
 * A pure shell over the WorkflowRuntimeView state machine: every handler
 * (open revision / validate / save revision) and every piece of state stays
 * in the parent view; this component only relocates the existing markup for
 * definition selection, the JSON editor, validation feedback, and revision
 * saving into a Dialog (same composition convention as SettingsDialog).
 * No new API calls, no new write paths.
 */
export function WorkflowDefinitionDialog({
  isOpen,
  onClose,
  zh,
  definitions,
  definitionsUnavailable,
  selectedDefinitionId,
  onDefinitionChange,
  selectedRevision,
  definitionText,
  onDefinitionTextChange,
  validating,
  validation,
  onValidate,
  isBuiltinSelected,
  onSaveRevision,
  saveNotice,
  saveError
}: {
  isOpen: boolean;
  onClose: () => void;
  zh: boolean;
  definitions: WorkflowRuntimeDefinitionSummary[] | null;
  definitionsUnavailable: boolean;
  selectedDefinitionId: string;
  onDefinitionChange: (definitionId: string) => void;
  selectedRevision: WorkflowRuntimeDefinitionRevision | null;
  definitionText: string;
  onDefinitionTextChange: (text: string) => void;
  validating: boolean;
  validation: { ok: boolean; errors: { code: string; message: string }[] } | null;
  onValidate: () => void;
  isBuiltinSelected: boolean;
  onSaveRevision: () => void;
  saveNotice?: string;
  saveError?: string;
}) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={zh ? "编辑定义" : "Edit definition"}
      description={
        zh
          ? "定义以 append-only revision 持久化；保存后即可被运行门禁钉住。"
          : "Definitions persist as append-only revisions; a saved revision can be pinned by the run gates."
      }
      className="ds-dialog--workflow-editor"
      footer={
        <>
          <Button type="button" size="sm" variant="secondary" disabled={validating} onClick={onValidate}>
            {validating ? <LoaderCircle size={13} className="spin" /> : <CheckCircle2 size={13} />}
            {zh ? "校验" : "Validate"}
          </Button>
          <Button type="button" size="sm" variant="primary" onClick={onSaveRevision} disabled={isBuiltinSelected}>
            <Save size={13} />
            {zh ? "保存 revision" : "Save revision"}
          </Button>
        </>
      }
    >
      <div className="ds-field-stack">
        {definitionsUnavailable ? (
          <div className="route-query-notice" role="alert">
            <strong>{zh ? "定义列表不可用" : "Definitions unavailable"}</strong>
          </div>
        ) : definitions !== null && definitions.length === 0 ? (
          <div className="ds-empty ds-empty--slim">
            <span className="ds-empty-icon"><Inbox size={20} /></span>
            <p className="ds-empty-text">{zh ? "尚无持久化定义（空 ≠ 不可用）。内置定义在服务启动时播种。" : "No persisted definitions yet (empty, not unavailable). The builtin seed appears after server startup."}</p>
          </div>
        ) : (
          <select
            className="ds-select"
            aria-label={zh ? "选择定义" : "Definition"}
            value={selectedDefinitionId}
            onChange={event => onDefinitionChange(event.target.value)}
          >
            {(definitions ?? []).map(summary => (
              <option key={summary.definitionId} value={summary.definitionId}>
                {summary.definitionId} · {summary.origin === "builtin" ? (zh ? "内置" : "builtin") : zh ? "用户" : "user"}
                {summary.latestRevision !== null ? ` · r${summary.latestRevision} ${summary.status === "validated" ? "✓" : "!"}` : ""}
              </option>
            ))}
          </select>
        )}
        {isBuiltinSelected && (
          <p className="muted-note">{zh ? "内置定义不可变；编辑并保存会创建新的用户定义。" : "The builtin definition is immutable; editing + saving creates a new user definition."}</p>
        )}
        {selectedRevision && (
          <p className="muted-note">
            {zh ? `当前 revision：r${selectedRevision.revision}（${selectedRevision.revisionId.slice(0, 14)}…）· ${selectedRevision.status === "validated" ? "可执行" : "草稿（不可执行）"}` : `Pinned revision r${selectedRevision.revision} (${selectedRevision.revisionId.slice(0, 14)}…) · ${selectedRevision.status}`}
          </p>
        )}
        {validation && (
          <div className={validation.ok ? "route-query-notice notice-success" : "route-query-notice"} role="status">
            <strong>{validation.ok ? (zh ? "校验通过" : "Validation passed") : (zh ? "校验失败（fail-closed）" : "Validation failed (fail-closed)")}</strong>
            {validation.errors.length > 0 && (
              <ul className="workflow-runtime-errors">
                {validation.errors.map((issue, index) => <li key={index}>{issue.code}: {issue.message}</li>)}
              </ul>
            )}
          </div>
        )}
        {saveNotice && <div className="route-query-notice notice-success" role="status"><span>{saveNotice}</span></div>}
        {saveError && <div className="route-query-notice" role="alert"><span>{saveError}</span></div>}
        <details className="workflow-definition-advanced" open>
          <summary className="ds-section-kicker">{zh ? "高级：直接编辑" : "Advanced: direct edit"}</summary>
          <textarea
            className="ds-textarea"
            spellCheck={false}
            rows={10}
            aria-label={zh ? "工作流定义 JSON" : "Workflow definition JSON"}
            value={definitionText}
            onChange={event => onDefinitionTextChange(event.target.value)}
          />
        </details>
      </div>
    </Dialog>
  );
}
