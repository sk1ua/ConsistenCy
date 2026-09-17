import React from "react";
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
}

/**
 * Minimal directory/tree panel. Full VCS tree API is not exposed yet;
 * surface working-tree changed + untracked paths as an honest stub tree.
 */
export const RepoDirectoryPanel: React.FC<RepoDirectoryPanelProps> = ({
  isOpen,
  onClose,
  repositoryId,
  displayName,
  locale
}) => {
  const zh = locale === "zh-CN";
  const gitStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryGitStatus(repositoryId),
    queryFn: () => api.repositoryGitStatus(repositoryId),
    enabled: isOpen && Boolean(repositoryId),
    refetchInterval: isOpen ? 10_000 : false
  });

  const changed = gitStatusQuery.data?.changedFiles ?? [];
  const untracked = gitStatusQuery.data?.untrackedFiles ?? [];
  const entries = [
    ...changed.map(f => ({ path: f.path, kind: "changed" as const })),
    ...untracked.map(path => ({ path, kind: "untracked" as const }))
  ];

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={zh ? `仓库目录 · ${displayName}` : `Repo directory · ${displayName}`}
      description={
        zh
          ? "完整目录树即将接入；当前展示工作区变更与未跟踪文件。"
          : "Full tree API coming soon; showing working-tree changes and untracked files."
      }
    >
      {gitStatusQuery.isLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
          <Loader2 size={14} className="ds-spin" />
          {zh ? "加载中…" : "Loading…"}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          compact
          icon={<FolderTree size={20} />}
          title={zh ? "工作区干净" : "Clean working tree"}
          description={zh ? "暂无变更文件可列。完整目录树即将接入。" : "No changed files. Full directory tree coming soon."}
        />
      ) : (
        <ul className="repo-directory-list">
          {entries.map(entry => (
            <li key={`${entry.kind}-${entry.path}`}>
              <FileCode2 size={13} />
              <span className="mono">{entry.path}</span>
              <Badge variant="neutral" size="sm">
                {entry.kind === "untracked" ? (zh ? "未跟踪" : "untracked") : (zh ? "变更" : "changed")}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
};
