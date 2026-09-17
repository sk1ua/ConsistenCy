import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  FolderTree,
  Loader2
} from "lucide-react";
import type { RepositoryFileContentResponse, RepositoryTreeEntry, RepositoryTreeResponse } from "@consistency/schema";
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

type CachedFolder = {
  loading: boolean;
  error?: string;
  truncated: boolean;
  entries: RepositoryTreeEntry[];
};

function changeLabel(kind: RepositoryTreeEntry["changeKind"], zh: boolean): string | null {
  if (kind === "changed") return zh ? "变更" : "changed";
  if (kind === "untracked") return zh ? "未跟踪" : "untracked";
  return null;
}

/**
 * Directory panel for a repository.
 * Lazy-loads folder children via `/repositories/:id/git/tree` (HEAD + dirty/untracked overlay).
 * Dirty files open Changes with highlightPath; clean files show a meta / preview stub.
 */

function FilePreviewBody({
  zh,
  loading,
  error,
  data
}: {
  zh: boolean;
  loading: boolean;
  error?: string;
  data?: RepositoryFileContentResponse;
}) {
  if (loading) {
    return (
      <div className="repo-directory-preview__status">
        <Loader2 size={14} className="ds-spin" />
        {zh ? "加载预览…" : "Loading preview…"}
      </div>
    );
  }
  if (error) {
    return <p className="repo-directory-preview__stub">{error}</p>;
  }
  if (!data) {
    return (
      <p className="repo-directory-preview__stub">
        {zh ? "选择文件以预览内容。" : "Select a file to preview its contents."}
      </p>
    );
  }
  if (!data.available) {
    return <p className="repo-directory-preview__stub">{data.reason}</p>;
  }
  if ("binary" in data && data.binary) {
    return (
      <p className="repo-directory-preview__stub" data-testid="repo-directory-preview-binary">
        {zh ? `二进制文件，无法预览（${data.size} B）。${data.reason}` : `Binary file — preview not shown (${data.size} B). ${data.reason}`}
      </p>
    );
  }
  if (!("content" in data)) {
    return <p className="repo-directory-preview__stub">{zh ? "无预览内容" : "No preview content"}</p>;
  }
  return (
    <div className="repo-directory-preview__content-wrap">
      <div className="repo-directory-preview__content-meta">
        <Badge variant="neutral" size="sm">{data.encoding}</Badge>
        {data.truncated ? (
          <Badge variant="neutral" size="sm">{zh ? "已截断" : "truncated"}</Badge>
        ) : null}
        <span className="repo-directory-preview__bytes">{data.size} B</span>
      </div>
      {data.encoding === "utf-8-lossy" ? (
        <p className="repo-directory-preview__encoding-note">
          {zh ? "非严格 UTF-8：已用替换字符显示。" : "Not strict UTF-8 — shown with replacement characters."}
        </p>
      ) : null}
      <pre className="repo-directory-preview__code" data-testid="repo-directory-preview-code">{data.content}</pre>
    </div>
  );
}

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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [folderCache, setFolderCache] = useState<Record<string, CachedFolder>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<RepositoryTreeEntry | null>(null);

  const gitStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryGitStatus(repositoryId),
    queryFn: () => api.repositoryGitStatus(repositoryId),
    enabled: isOpen && Boolean(repositoryId),
    refetchInterval: isOpen ? 10_000 : false
  });

  const rootTreeQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryTree(repositoryId, ""),
    queryFn: () => api.repositoryTree(repositoryId, ""),
    enabled: isOpen && Boolean(repositoryId)
  });

  const selectedBlobPath = selectedMeta?.type === "blob" ? selectedMeta.path : null;
  const filePreviewQuery = useQuery({
    queryKey: workspaceQueryKeys.repositoryFileContent(repositoryId, selectedBlobPath ?? ""),
    queryFn: () => api.repositoryFileContent(repositoryId, selectedBlobPath!),
    enabled: isOpen && Boolean(repositoryId) && Boolean(selectedBlobPath)
  });

  const dirtyPaths = useMemo(() => {
    const set = new Set<string>();
    for (const file of gitStatusQuery.data?.changedFiles ?? []) set.add(file.path);
    for (const path of gitStatusQuery.data?.untrackedFiles ?? []) set.add(path);
    return set;
  }, [gitStatusQuery.data]);

  React.useEffect(() => {
    if (!isOpen) {
      setExpanded(new Set([""]));
      setFolderCache({});
      setSelectedPath(null);
      setSelectedMeta(null);
      return;
    }
    const data = rootTreeQuery.data;
    if (!data) return;
    if (!data.available) {
      setFolderCache(prev => ({
        ...prev,
        "": { loading: false, error: data.reason, truncated: false, entries: [] }
      }));
      return;
    }
    setFolderCache(prev => ({
      ...prev,
      "": {
        loading: false,
        truncated: data.truncated,
        entries: data.entries
      }
    }));
  }, [isOpen, rootTreeQuery.data]);

  const loadFolder = async (path: string) => {
    setFolderCache(prev => ({
      ...prev,
      [path]: prev[path] ?? { loading: true, truncated: false, entries: [] }
    }));
    try {
      const data: RepositoryTreeResponse = await api.repositoryTree(repositoryId, path);
      if (!data.available) {
        setFolderCache(prev => ({
          ...prev,
          [path]: { loading: false, error: data.reason, truncated: false, entries: [] }
        }));
        return;
      }
      setFolderCache(prev => ({
        ...prev,
        [path]: { loading: false, truncated: data.truncated, entries: data.entries }
      }));
    } catch (error) {
      setFolderCache(prev => ({
        ...prev,
        [path]: {
          loading: false,
          error: error instanceof Error ? error.message : "failed",
          truncated: false,
          entries: []
        }
      }));
    }
  };

  const toggleFolder = (path: string) => {
    const willExpand = !expanded.has(path);
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (willExpand && !folderCache[path]) void loadFolder(path);
  };

  const openDirtyFile = (path: string) => {
    if (onOpenFile) {
      onOpenFile(path);
      return;
    }
    onClose();
    navigate(`/repositories/${encodeURIComponent(repositoryId)}/changes`, {
      state: { highlightPath: path }
    });
  };

  const onFileClick = (entry: RepositoryTreeEntry) => {
    setSelectedPath(entry.path);
    setSelectedMeta(entry);
    const dirty = entry.changeKind === "changed" || entry.changeKind === "untracked" || dirtyPaths.has(entry.path);
    if (dirty) {
      // Dirty → Changes (existing UX). Clean files stay for content preview.
      openDirtyFile(entry.path);
    }
  };

  const renderEntries = (path: string, depth: number): React.ReactNode => {
    const folder = folderCache[path];
    if (!folder) {
      if (path === "" && rootTreeQuery.isLoading) {
        return (
          <div className="repo-directory-tree__status">
            <Loader2 size={14} className="ds-spin" />
            {zh ? "加载目录…" : "Loading tree…"}
          </div>
        );
      }
      return null;
    }
    if (folder.loading) {
      return (
        <div className="repo-directory-tree__status" style={{ paddingLeft: 8 + depth * 14 }}>
          <Loader2 size={14} className="ds-spin" />
          {zh ? "加载中…" : "Loading…"}
        </div>
      );
    }
    if (folder.error) {
      return (
        <p className="repo-directory-section__empty" style={{ paddingLeft: 8 + depth * 14 }}>
          {folder.error}
        </p>
      );
    }
    if (folder.entries.length === 0) {
      return (
        <p className="repo-directory-section__empty" style={{ paddingLeft: 8 + depth * 14 }}>
          {zh ? "空目录" : "Empty folder"}
        </p>
      );
    }
    return (
      <ul className="repo-directory-tree" aria-label={path || (zh ? "仓库根目录" : "Repository root")}>
        {folder.entries.map(entry => {
          if (entry.type === "tree") {
            const isOpenFolder = expanded.has(entry.path);
            return (
              <li key={`dir-${entry.path}`}>
                <button
                  type="button"
                  className={`repo-directory-tree__row${selectedPath === entry.path ? " is-selected" : ""}`}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  onClick={() => {
                    setSelectedPath(entry.path);
                    setSelectedMeta(entry);
                    toggleFolder(entry.path);
                  }}
                  aria-expanded={isOpenFolder}
                >
                  {isOpenFolder ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {isOpenFolder ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span className="mono">{entry.name}</span>
                  {changeLabel(entry.changeKind, zh) && (
                    <Badge variant="neutral" size="sm">{changeLabel(entry.changeKind, zh)}</Badge>
                  )}
                </button>
                {isOpenFolder ? renderEntries(entry.path, depth + 1) : null}
              </li>
            );
          }
          const label = changeLabel(entry.changeKind, zh);
          return (
            <li key={`file-${entry.path}`}>
              <button
                type="button"
                className={`repo-directory-tree__row repo-directory-list__item${selectedPath === entry.path ? " is-selected" : ""}`}
                style={{ paddingLeft: 8 + depth * 14 + 16 }}
                onClick={() => onFileClick(entry)}
                title={
                  label
                    ? (zh ? "预览文件；可在右侧打开变更视图" : "Preview file; open Changes from the right pane")
                    : (zh ? "预览文件内容" : "Preview file contents")
                }
              >
                <FileCode2 size={13} />
                <span className="mono">{entry.name}</span>
                {label && <Badge variant="neutral" size="sm">{label}</Badge>}
              </button>
            </li>
          );
        })}
        {folder.truncated && (
          <li className="repo-directory-tree__truncated" style={{ paddingLeft: 8 + depth * 14 }}>
            {zh ? "已截断：此目录条目过多" : "Truncated: too many entries in this folder"}
          </li>
        )}
      </ul>
    );
  };

  const root = folderCache[""];
  const treeUnavailable = rootTreeQuery.data?.available === false;
  const statusUnavailable = gitStatusQuery.data?.available === false;
  const available = !treeUnavailable && (rootTreeQuery.data?.available !== false);

  const selectedIsDirty = selectedMeta
    ? selectedMeta.changeKind === "changed"
      || selectedMeta.changeKind === "untracked"
      || dirtyPaths.has(selectedMeta.path)
    : false;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={zh ? `仓库目录 · ${displayName}` : `Repository tree · ${displayName}`}
      description={
        zh
          ? "按文件夹浏览 HEAD 树；变更 / 未跟踪会标出。点击脏文件跳转变更视图；干净文件在右侧预览内容。"
          : "Browse the HEAD tree by folder. Changed and untracked paths are marked. Dirty files open Changes; clean files preview on the right."
      }
      className="repo-directory-dialog"
    >
      {rootTreeQuery.isLoading && !root ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
          <Loader2 size={14} className="ds-spin" />
          {zh ? "加载中…" : "Loading…"}
        </div>
      ) : treeUnavailable || (!available && root?.error) ? (
        <EmptyState
          compact
          icon={<FolderTree size={20} />}
          title={zh ? "无法读取目录树" : "Directory tree unavailable"}
          description={
            rootTreeQuery.data && !rootTreeQuery.data.available
              ? rootTreeQuery.data.reason
              : root?.error ?? (zh ? "仓库目录暂时不可用。" : "Repository tree is temporarily unavailable.")
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
        <div className="repo-directory-layout">
          <div className="repo-directory-sections">
            <div className="repo-directory-section">
              <div className="repo-directory-section__label">
                <span>{zh ? "目录树" : "Tree"}</span>
                {rootTreeQuery.data?.available && rootTreeQuery.data.revision && (
                  <Badge variant="neutral" size="sm">
                    <span className="mono">{rootTreeQuery.data.revision.slice(0, 7)}</span>
                  </Badge>
                )}
                {!statusUnavailable && gitStatusQuery.data && (
                  <Badge variant="neutral" size="sm">
                    {zh
                      ? `${gitStatusQuery.data.dirtyFileCount + gitStatusQuery.data.untrackedFileCount} 脏`
                      : `${gitStatusQuery.data.dirtyFileCount + gitStatusQuery.data.untrackedFileCount} dirty`}
                  </Badge>
                )}
              </div>
              {renderEntries("", 0)}
            </div>
          </div>

          <div className="repo-directory-preview" data-testid="repo-directory-preview">
            {selectedMeta && selectedMeta.type === "blob" ? (
              <>
                <div className="repo-directory-preview__title">
                  <FileCode2 size={14} />
                  <span className="mono">{selectedMeta.path}</span>
                </div>
                <dl className="repo-directory-preview__meta">
                  <div>
                    <dt>{zh ? "类型" : "Type"}</dt>
                    <dd>{zh ? "文件" : "File"}</dd>
                  </div>
                  {selectedMeta.size !== undefined && (
                    <div>
                      <dt>{zh ? "大小" : "Size"}</dt>
                      <dd>{selectedMeta.size} B</dd>
                    </div>
                  )}
                  {selectedMeta.sha && (
                    <div>
                      <dt>SHA</dt>
                      <dd className="mono">{selectedMeta.sha.slice(0, 12)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{zh ? "工作区" : "Worktree"}</dt>
                    <dd>
                      {selectedIsDirty
                        ? (zh ? "有未提交变更" : "Has uncommitted changes")
                        : (zh ? "干净" : "Clean")}
                    </dd>
                  </div>
                </dl>
                {selectedIsDirty ? (
                  <button
                    type="button"
                    className="related-card__text-btn"
                    onClick={() => openDirtyFile(selectedMeta.path)}
                  >
                    {zh ? "在变更视图中打开" : "Open in changes view"}
                  </button>
                ) : null}
                <FilePreviewBody
                  zh={zh}
                  loading={filePreviewQuery.isLoading}
                  error={filePreviewQuery.isError ? (filePreviewQuery.error instanceof Error ? filePreviewQuery.error.message : "error") : undefined}
                  data={filePreviewQuery.data}
                />
              </>
            ) : selectedMeta && selectedMeta.type === "tree" ? (
              <>
                <div className="repo-directory-preview__title">
                  <Folder size={14} />
                  <span className="mono">{selectedMeta.path || "."}</span>
                </div>
                <p className="repo-directory-preview__stub">
                  {zh ? "展开左侧文件夹以浏览子项。" : "Expand the folder on the left to browse children."}
                </p>
              </>
            ) : (
              <p className="repo-directory-preview__stub">
                {zh ? "选择文件预览内容，或点击脏文件打开变更。" : "Select a file to preview, or click a dirty file to open Changes."}
              </p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
};
