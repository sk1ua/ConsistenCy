import React, { useState } from "react";
import { FolderGit2, Github, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Dialog } from "../design-system/Dialog";
import { Button } from "../design-system/Button";
import { Input } from "../design-system/Input";
import { desktopBridge } from "../desktop";
import { api } from "../api/client";

export interface ConnectRepositoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (repository: any) => void;
}

export const ConnectRepositoryDialog: React.FC<ConnectRepositoryDialogProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
  const [tab, setTab] = useState<"local" | "github">("local");
  const [githubUrl, setGithubUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isDesktop = Boolean(desktopBridge());

  const handleSelectLocal = async () => {
    setError(null);
    setLoading(true);
    try {
      const bridge = desktopBridge();
      if (!bridge) {
        throw new Error("本地目录选择器仅在 Electron 桌面端可用");
      }
      const result = await bridge.selectRepository();
      if (result.canceled) {
        setLoading(false);
        return;
      }
      if ("error" in result) {
        throw new Error(result.error);
      }
      onSuccess(result.repository);
      onClose();
    } catch (err: any) {
      setError(err.message || "连接本地仓库失败");
    } finally {
      setLoading(false);
    }
  };

  const handleConnectGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim()) return;
    setError(null);
    setLoading(true);

    try {
      // Parse owner/repo or full url
      let fullName = githubUrl.trim();
      const match = fullName.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match && match[1] && match[2]) {
        fullName = `${match[1]}/${match[2].replace(/\.git$/, "")}`;
      }

      if (!fullName.includes("/")) {
        throw new Error("请输入有效的 GitHub 仓库名称，例如 'owner/repo'");
      }

      // If it's a pull request url, trigger public pr analysis
      if (githubUrl.includes("/pull/")) {
        const res = await api.analyzePublicPr(githubUrl);
        onSuccess({ id: res.repository, displayName: res.repository, source: "github" });
        onClose();
        return;
      }

      // Otherwise we can register remote repository or trigger review
      onSuccess({ id: fullName, displayName: fullName, source: "github" });
      onClose();
    } catch (err: any) {
      setError(err.message || "连接 GitHub 仓库失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="连接代码仓库 (Connect Repository)"
      description="连接本地 Git 工作区或远程 GitHub 仓库以开始证据驱动的代码审查。"
      sizeVariant="md"
    >
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        <Button
          variant={tab === "local" ? "primary" : "secondary"}
          size="sm"
          icon={<FolderGit2 size={14} />}
          onClick={() => {
            setTab("local");
            setError(null);
          }}
        >
          本地 Git 仓库
        </Button>
        <Button
          variant={tab === "github" ? "primary" : "secondary"}
          size="sm"
          icon={<Github size={14} />}
          onClick={() => {
            setTab("github");
            setError(null);
          }}
        >
          GitHub 仓库 / PR
        </Button>
      </div>

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderRadius: "var(--ds-radius-md)",
            background: "var(--danger-soft)",
            color: "var(--danger-strong)",
            fontSize: "13px",
            marginBottom: "16px"
          }}
        >
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {tab === "local" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ fontSize: "13px", color: "var(--muted)", margin: 0 }}>
            选择本地文件系统上的 Git 仓库目录。ConsistenCy 将以只读方式安全分析工作区状态与代码差异。
          </p>

          <div
            style={{
              padding: "24px",
              border: "1px dashed var(--border-strong)",
              borderRadius: "var(--ds-radius-md)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              background: "var(--surface-subtle)"
            }}
          >
            <FolderGit2 size={32} style={{ color: "var(--muted)" }} />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 600, fontSize: "13px" }}>本地工作区接入</div>
              <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
                {isDesktop
                  ? "点击下方按钮调用系统原生文件夹选择器"
                  : "当前处于浏览器模式，本地仓库选择器需要在 Electron 桌面端中使用"}
              </div>
            </div>

            <Button
              variant="primary"
              size="md"
              icon={loading ? <Loader2 size={14} className="ds-spin" /> : <FolderGit2 size={14} />}
              disabled={!isDesktop || loading}
              onClick={handleSelectLocal}
            >
              {loading ? "正在注册..." : "选择本地文件夹..."}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleConnectGithub} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ fontSize: "13px", color: "var(--muted)", margin: 0 }}>
            输入公开 GitHub 仓库名称（如 <code>owner/repo</code>）或 Pull Request 完整链接。
          </p>

          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
              GitHub 仓库或 PR 链接
            </label>
            <Input
              type="text"
              value={githubUrl}
              onChange={e => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123 或 owner/repo"
              prefixIcon={<Github size={14} />}
              required
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={!githubUrl.trim() || loading}
            >
              连接并分析
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
};
