import { Inbox, LoaderCircle, PlayCircle } from "lucide-react";
import type { Repository, WorkflowRuntimeDefinitionRevision } from "@consistency/schema";
import { Button } from "../design-system/Button";
import { Dialog } from "../design-system/Dialog";

/**
 * Configure-execution dialog for the verified runtime tab (dialog-first IA).
 * Pure shell over the WorkflowRuntimeView state machine: repository selection,
 * the pinned-revision trigger binding summary, and the existing run handler
 * (unchanged bounded polling loop) stay in the parent view. No new API calls,
 * no new write paths, no new permissions.
 */
export function WorkflowExecutionDialog({
  isOpen,
  onClose,
  zh,
  repositories,
  repositoriesUnavailable,
  repositoryId,
  onRepositoryChange,
  selectedRevision,
  selectedDefinitionId,
  triggering,
  onRun,
  runError
}: {
  isOpen: boolean;
  onClose: () => void;
  zh: boolean;
  repositories: Repository[] | null;
  repositoriesUnavailable: boolean;
  repositoryId: string;
  onRepositoryChange: (repositoryId: string) => void;
  selectedRevision: WorkflowRuntimeDefinitionRevision | null;
  selectedDefinitionId: string;
  triggering: boolean;
  onRun: () => void;
  runError?: string;
}) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={zh ? "配置执行" : "Configure execution"}
      description={
        zh
          ? "绑定已注册仓库触发（pin 当前 revision）；执行始终绑定仓库的 HEAD 快照（SHA 钉定）。"
          : "Trigger on a registered repository (pins the current revision); execution always binds the repository's SHA-pinned HEAD snapshot."
      }
      footer={
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={triggering || repositoryId.length === 0}
          onClick={onRun}
        >
          {triggering ? <LoaderCircle size={13} className="spin" /> : <PlayCircle size={13} />}
          {triggering ? (zh ? "运行中…" : "Running…") : zh ? "运行" : "Run"}
        </Button>
      }
    >
      <div className="ds-field-stack">
        {repositoriesUnavailable ? (
          <div className="route-query-notice" role="alert">
            <strong>{zh ? "仓库列表不可用" : "Repository list unavailable"}</strong>
          </div>
        ) : repositories !== null && repositories.length === 0 ? (
          <div className="ds-empty ds-empty--slim">
            <span className="ds-empty-icon"><Inbox size={20} /></span>
            <p className="ds-empty-text">{zh ? "尚无已注册仓库（空 ≠ 不可用）。请先在「代码仓库」页连接本地 Git 仓库。" : "No repositories registered yet (empty, not unavailable). Connect one on the Repositories page first."}</p>
          </div>
        ) : (
          <select
            className="ds-select"
            aria-label={zh ? "选择仓库" : "Repository"}
            value={repositoryId}
            onChange={event => onRepositoryChange(event.target.value)}
          >
            {(repositories ?? []).map(repository => (
              <option key={repository.id} value={repository.id}>
                {repository.displayName} ({repository.source === "local_git" ? (zh ? "本地" : "local") : repository.source})
              </option>
            ))}
          </select>
        )}
        <p className="muted-note">
          {selectedRevision
            ? (zh
              ? `触发绑定：手动 · pin ${selectedDefinitionId} r${selectedRevision.revision}`
              : `Trigger binding: manual · pins ${selectedDefinitionId} r${selectedRevision.revision}`)
            : (zh
              ? "触发绑定：手动 · 使用服务端默认 revision"
              : "Trigger binding: manual · server default revision")}
        </p>
        {runError && <div className="route-query-notice" role="alert"><strong>{zh ? "运行失败" : "Run failed"}</strong><span>{runError}</span></div>}
      </div>
    </Dialog>
  );
}
