import React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderTree, FileCode2, Loader2 } from "lucide-react";
import { api } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { Dialog } from "../design-system/Dialog";
import { EmptyState } from "../design-system/EmptyState";
import { Badge } from "../design-system/Badge";

export interface RepoDirectoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  repositoryId: string;
  displayName: string;
  locale: "zh-CN" | "en-US";
  /** Optional override; default navigates to the repo changes tab. */
  onOpenFile?: (path: string) => void;
}

/**
 * Directory panel for a repository.
 * Full VCS tree API is not exposed yet — present working-tree changed + untracked
 * paths in clear sections. Clicking a file opens the changes tab with highlightPath.
 */
export const RepoDirectoryPanel: React.FC<RepoDirectoryPanelProps> = ({
  isOpen,
  onClose,
  repositoryId,
  displayName,
  locale,
  onOpenFile
}) => {
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const gitStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryGitStatus(repositoryId),
    queryFn: () => api.repositoryGitStatus(repositoryId),
    enabled: isOpen && Boolean(repositoryId),
    refetchInterval: isOpen ? 10_000 : false
  });

  const changed = gitStatusQuery.data?.changedFiles ?? [];
  const untracked = gitStatusQuery.data?.untrackedFiles ?? [];
  const hasEntries = changed.length + untracked.length > 0;

  const openFile = (path: string) => {
    if (onOpenFile) {
      onOpenFile(path);
      return;
    }
    onClose();
    navigate(`/repositories/${encodeURIComponent(repositoryId)}/changes`, {
      state: { highlightPath: path }
    });
  };

  const renderSection = (
    title: string,
    items: Array<{ path: string; kind: "changed" | "untracked" }>
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="repo-directory-section">
        <div className="repo-directory-section__label">
          <span>{title}</span>
          <Badge variant="neutral" size="sm">{items.length}</Badge>
        </div>
        <ul className="repo-directory-list" aria-label={title}>
          {items.map(entry => (
            <li key={`${entry.kind}-${entry.path}`}>
              <button
                type="button"
                className="repo-directory-list__item"
                onClick={() => openFile(entry.path)}
                title={zh ? "在变更视图中打开并高亮" : "Open and highlight in changes view"}
              >
                <FileCode2 size={13} />
                <span className="mono">{entry.path}</span>
                <Badge variant="neutral" size="sm">
                  {entry.kind === "untracked" ? (zh ? "未跟踪" : "untracked") : (zh ? "变更" : "changed")}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={zh ? `工作区文件 · ${displayName}` : `Working tree · ${displayName}`}
      description={
        zh
          ? "完整目录树尚未接入；当前按变更 / 未跟踪分区列出。点击文件可打开变更视图并高亮该行。"
          : "Full tree API not available yet — listing changed and untracked files in sections. Click a file to open Changes with that row highlighted."
      }
    >
      {gitStatusQuery.isLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
          <Loader2 size={14} className="ds-spin" />
          {zh ? "加载中…" : "Loading…"}
        </div>
      ) : !hasEntries ? (
        <EmptyState
          compact
          icon={<FolderTree size={20} />}
          title={zh ? "工作区干净" : "Clean working tree"}
          description={
            zh
              ? "暂无变更或未跟踪文件。完整目录树即将接入。"
              : "No changed or untracked files. Full directory tree coming soon."
          }
          action={
            <button
              type="button"
              className="related-card__text-btn"
              onClick={() => {
                onClose();
                navigate(`/repositories/${encodeURIComponent(repositoryId)}/changes`);
              }}
            >
              {zh ? "打开变更视图" : "Open changes view"}
            </button>
          }
        />
      ) : (
        <div className="repo-directory-sections">
          {renderSection(
            zh ? "已变更" : "Changed",
            changed.map(f => ({ path: f.path, kind: "changed" as const }))
          )}
          {renderSection(
            zh ? "未跟踪" : "Untracked",
            untracked.map(path => ({ path, kind: "untracked" as const }))
          )}
        </div>
      )}
    </Dialog>
  );
};
