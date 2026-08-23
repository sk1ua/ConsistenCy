import React from "react";
import type { RepositoryCommitsResponse } from "@consistency/schema";
import { EmptyState } from "../design-system/EmptyState";
import { Badge } from "../design-system/Badge";
import { useI18n } from "../i18n";
import { GitCommit, AlertCircle, Loader2 } from "lucide-react";

export interface RepositoryHistoryViewProps {
  data?: RepositoryCommitsResponse | null;
  isLoading?: boolean;
}

/**
 * Stable UI mapping for the sanitized, fixed backend reasons. Raw backend
 * reasons are never machine-translated; unknown reasons fall back to a
 * localized generic description instead of leaking English into zh-CN.
 */
const UNAVAILABLE_REASONS: Record<string, { zh: string; en: string }> = {
  "unable to read commit history": { zh: "无法读取本地 Git 提交历史。", en: "Unable to read the local Git commit history." },
  "由于网络或服务异常，无法加载提交历史": {
    zh: "由于网络或服务异常，无法加载提交历史",
    en: "Failed to load commit history due to network or service error"
  },
  "Failed to load commit history due to network or service error": {
    zh: "由于网络或服务异常，无法加载提交历史",
    en: "Failed to load commit history due to network or service error"
  }
};

export function localizeHistoryUnavailableReason(reason: string | undefined, locale: string): string | undefined {
  if (!reason) return undefined;
  const known = UNAVAILABLE_REASONS[reason];
  if (known) return locale === "zh-CN" ? known.zh : known.en;
  return locale === "zh-CN" ? "无法读取本地 Git 提交历史。" : reason;
}

export const RepositoryHistoryView: React.FC<RepositoryHistoryViewProps> = ({ data, isLoading }) => {
  const { locale } = useI18n();

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
        <Loader2 size={24} className="ds-spin" style={{ marginRight: "8px", color: "var(--muted)" }} />
        <span style={{ color: "var(--muted)" }}>{locale === "zh-CN" ? "正在加载提交历史..." : "Loading Git history..."}</span>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  if (!data.available) {
    return (
      <EmptyState
        icon={<AlertCircle size={24} style={{ color: "var(--danger)" }} />}
        title={locale === "zh-CN" ? "提交历史不可用" : "Git history unavailable"}
        description={localizeHistoryUnavailableReason(data.reason, locale)}
        compact
      />
    );
  }

  if (data.commits.length === 0) {
    return (
      <EmptyState
        icon={<GitCommit size={24} />}
        title={locale === "zh-CN" ? "暂无提交" : "No commits"}
        description={locale === "zh-CN" ? "当前仓库暂无提交记录。" : "No commits found in this repository."}
        compact
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {data.commits.map((commit) => {
        const date = new Date(commit.authoredAt);
        const formattedDate = new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "numeric"
        }).format(date);

        return (
          <div
            key={commit.sha}
            style={{
              padding: "12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              display: "flex",
              flexDirection: "column",
              gap: "4px"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
              <span style={{ fontWeight: 500, color: "var(--foreground)", wordBreak: "break-word", fontSize: "14px" }}>
                {commit.message}
              </span>
              <Badge mono size="sm">{commit.sha.substring(0, 7)}</Badge>
            </div>
            <div style={{ display: "flex", gap: "8px", fontSize: "12px", color: "var(--muted)" }}>
              <span>{commit.author.name}</span>
              <span>&middot;</span>
              <span>{formattedDate}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
