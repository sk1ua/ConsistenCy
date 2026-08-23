import { useState, useMemo, useEffect, KeyboardEvent } from "react";
import type { RepositoryGitStatusResponse, VcsChangedFile } from "@consistency/schema";
import { useI18n } from "../i18n";
import { FileCode2, GitMerge, FileQuestion } from "lucide-react";

export interface RepositoryChangesViewProps {
  loading?: boolean;
  error?: Error;
  data?: RepositoryGitStatusResponse;
}

export type ListEntry =
  | { type: "tracked"; key: string; file: VcsChangedFile }
  | { type: "untracked"; key: string; path: string };

export function buildEntries(data?: RepositoryGitStatusResponse): ListEntry[] {
  if (!data) return [];
  const tracked: ListEntry[] = data.changedFiles.map(file => ({ type: "tracked", key: `tracked:${file.path}`, file }));
  const untracked: ListEntry[] = data.untrackedFiles.map(path => ({ type: "untracked", key: `untracked:${path}`, path }));
  
  tracked.sort((a, b) => a.key.localeCompare(b.key));
  untracked.sort((a, b) => a.key.localeCompare(b.key));
  return [...tracked, ...untracked];
}

export function statusLabel(status: VcsChangedFile["status"]): string {
  switch (status) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "untracked": return "U";
    case "type_changed": return "T";
  }
}

export function getNextSelection(entries: ListEntry[], currentKey: string | null, direction: "up" | "down"): string | null {
  if (entries.length === 0) return null;
  const index = entries.findIndex(e => e.key === currentKey);
  if (index === -1) return entries[0]!.key;
  if (direction === "down" && index < entries.length - 1) return entries[index + 1]!.key;
  if (direction === "up" && index > 0) return entries[index - 1]!.key;
  return currentKey;
}

const LOCALES = {
  "en-US": {
    loading: "Loading...",
    clean: "Working directory clean. No changes to show.",
    changedFiles: "Changed files",
    untrackedFile: "Untracked file",
    binaryFile: "Binary file not shown.",
    noTextChanges: "No text changes.",
    diffAria: "Code diff",
    noChangesToShow: "No changes to show.",
    totalCount: "Total",
    trackedCount: "Tracked",
    untrackedCount: "Untracked"
  },
  "zh-CN": {
    loading: "加载中...",
    clean: "工作区干净。没有可显示的变更。",
    changedFiles: "变更文件",
    untrackedFile: "未跟踪文件",
    binaryFile: "二进制文件不显示。",
    noTextChanges: "没有文本变更。",
    diffAria: "代码差异",
    noChangesToShow: "没有可显示的变更。",
    totalCount: "总计",
    trackedCount: "已跟踪",
    untrackedCount: "未跟踪"
  }
};

export function RepositoryChangesView({ loading, error, data }: RepositoryChangesViewProps) {
  const { locale } = useI18n();
  const strings = LOCALES[locale === "zh-CN" ? "zh-CN" : "en-US"];

  const entries = useMemo(() => buildEntries(data), [data]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (entries.length > 0 && (!selectedKey || !entries.find(e => e.key === selectedKey))) {
      setSelectedKey(entries[0]!.key);
    }
  }, [entries, selectedKey]);

  if (loading || error) {
    return <div className="changes-view-loading">{strings.loading}</div>;
  }

  if (data && data.available === false) {
    return (
      <div className="changes-view-unavailable">
        <p>{data.reason}</p>
      </div>
    );
  }

  if (data && entries.length === 0) {
    return (
      <div className="changes-view-clean">
        <GitMerge size={24} />
        <p>{strings.clean}</p>
      </div>
    );
  }

  const selectedEntry = entries.find(e => e.key === selectedKey) || entries[0];

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextKey = getNextSelection(entries, selectedKey, "down");
      if (nextKey) setSelectedKey(nextKey);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevKey = getNextSelection(entries, selectedKey, "up");
      if (prevKey) setSelectedKey(prevKey);
    }
  };

  return (
    <div className="diff-viewer">
      {data && (
        <nav className="diff-file-list" aria-label={strings.changedFiles} role="listbox">
          <h3>
            {strings.changedFiles}
            <span className="count-badges" role="group" aria-label={strings.changedFiles}>
              <span className="count-badge count-badge-total" aria-label={`${strings.totalCount}: ${data.dirtyFileCount + data.untrackedFileCount}`}>
                <span className="count-badge-label">{strings.totalCount}</span>
                <strong className="count-badge-value">{data.dirtyFileCount + data.untrackedFileCount}</strong>
              </span>
              <span className="count-badge count-badge-tracked" aria-label={`${strings.trackedCount}: ${data.dirtyFileCount}`}>
                <span className="count-badge-label">{strings.trackedCount}</span>
                <strong className="count-badge-value">{data.dirtyFileCount}</strong>
              </span>
              <span className="count-badge count-badge-untracked" aria-label={`${strings.untrackedCount}: ${data.untrackedFileCount}`}>
                <span className="count-badge-label">{strings.untrackedCount}</span>
                <strong className="count-badge-value">{data.untrackedFileCount}</strong>
              </span>
            </span>
          </h3>
          <ul className="diff-tree">
            {entries.map(entry => {
              const active = entry.key === selectedKey;
              if (entry.type === "tracked") {
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className={`diff-tree-file${active ? " active" : ""}`}
                      aria-selected={active}
                      role="option"
                      onClick={() => setSelectedKey(entry.key)}
                      onKeyDown={handleKeyDown}
                    >
                      <span className={`diff-status diff-status-${entry.file.status}`}>
                        {statusLabel(entry.file.status)}
                      </span>
                      <code>{entry.file.path}</code>
                      <small>+{entry.file.additions} -{entry.file.deletions}</small>
                    </button>
                  </li>
                );
              } else {
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className={`diff-tree-file${active ? " active" : ""}`}
                      aria-selected={active}
                      role="option"
                      onClick={() => setSelectedKey(entry.key)}
                      onKeyDown={handleKeyDown}
                    >
                      <span className="diff-status diff-status-untracked">U</span>
                      <code>{entry.path}</code>
                    </button>
                  </li>
                );
              }
            })}
          </ul>
        </nav>
      )}
      <section className="diff-content">
        {!selectedEntry ? (
          <div className="empty-inline">{strings.noChangesToShow}</div>
        ) : selectedEntry.type === "untracked" ? (
          <>
            <div className="diff-file-head">
              <FileQuestion size={16} />
              <strong>{selectedEntry.path}</strong>
              <span className="diff-status diff-status-untracked">U</span>
            </div>
            <div className="metadata-only">{strings.untrackedFile}</div>
          </>
        ) : (
          <>
            <div className="diff-file-head">
              <FileCode2 size={16} />
              <strong>{selectedEntry.file.path}</strong>
              <span className={`diff-status diff-status-${selectedEntry.file.status}`}>
                {statusLabel(selectedEntry.file.status)}
              </span>
              {selectedEntry.file.status === "renamed" && selectedEntry.file.previousPath && (
                <div className="rename-info">
                  {selectedEntry.file.previousPath} &rarr; {selectedEntry.file.path}
                </div>
              )}
            </div>
            {selectedEntry.file.binary ? (
              <div className="metadata-only">{strings.binaryFile}</div>
            ) : selectedEntry.file.hunks.length === 0 ? (
              <div className="empty-inline">{strings.noTextChanges}</div>
            ) : (
              <div className="diff-grid" tabIndex={0} role="region" aria-label={strings.diffAria}>
                {selectedEntry.file.hunks.map((hunk, i) => {
                  const lines = hunk.content.endsWith("\n") ? hunk.content.slice(0, -1).split("\n") : hunk.content.split("\n");
                  return (
                    <div key={i} className="diff-hunk">
                      <div className="diff-row diff-mode-unified diff-row-meta">
                        <span className="diff-ln"></span>
                        <span className="diff-ln"></span>
                        <span className="diff-code">{hunk.header}</span>
                      </div>
                      {lines.map((line, j) => {
                        const marker = line[0] || "";
                        const text = marker ? line.slice(1) : "";
                        const type = marker === "-" ? "del" : marker === "+" ? "add" : marker === " " ? "context" : "meta";
                        return (
                          <div key={j} className={`diff-row diff-mode-unified diff-row-${type}`}>
                            <span className="diff-ln"></span>
                            <span className="diff-ln"></span>
                            <span className="diff-code">{marker !== " " && marker !== "\\" ? marker : ""}{text}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
