import React, { useState, useEffect, useRef } from "react";
import { Search, FolderGit2, PlayCircle, ShieldAlert, GitFork, Settings, Sun, Moon, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../theme";

export interface CommandItem {
  id: string;
  title: string;
  category: "Navigation" | "Actions" | "Repositories" | "Theme";
  icon?: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  customCommands?: CommandItem[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  customCommands = []
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const { resolved, cycle } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultCommands: CommandItem[] = [
    {
      id: "nav-repos",
      title: "跳转到仓库列表 (Repositories)",
      category: "Navigation",
      icon: <FolderGit2 size={16} />,
      onSelect: () => {
        navigate("/repositories");
        onClose();
      }
    },
    {
      id: "nav-runs",
      title: "跳转到审查运行记录 (Runs)",
      category: "Navigation",
      icon: <PlayCircle size={16} />,
      onSelect: () => {
        navigate("/runs");
        onClose();
      }
    },
    {
      id: "nav-findings",
      title: "跳转到审查发现 (Findings)",
      category: "Navigation",
      icon: <ShieldAlert size={16} />,
      onSelect: () => {
        navigate("/findings");
        onClose();
      }
    },
    {
      id: "nav-workflows",
      title: "跳转到工作流定义 (Workflows)",
      category: "Navigation",
      icon: <GitFork size={16} />,
      onSelect: () => {
        navigate("/workflows");
        onClose();
      }
    },
    {
      id: "nav-settings",
      title: "跳转到系统设置 (Settings)",
      category: "Navigation",
      icon: <Settings size={16} />,
      onSelect: () => {
        navigate("/settings");
        onClose();
      }
    },
    {
      id: "theme-toggle",
      title: `切换为${resolved === "dark" ? "明亮" : "暗黑"}主题`,
      category: "Theme",
      icon: resolved === "dark" ? <Sun size={16} /> : <Moon size={16} />,
      onSelect: () => {
        cycle();
        onClose();
      }
    }
  ];

  const allCommands = [...defaultCommands, ...customCommands];

  const filtered = query.trim()
    ? allCommands.filter(cmd =>
        cmd.title.toLowerCase().includes(query.toLowerCase()) ||
        cmd.category.toLowerCase().includes(query.toLowerCase())
      )
    : allCommands;

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % (filtered.length || 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + (filtered.length || 1)) % (filtered.length || 1));
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        filtered[selectedIndex].onSelect();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filtered, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="ds-dialog-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ alignItems: "flex-start", paddingTop: "12vh" }}
    >
      <div
        className="ds-dialog"
        style={{
          maxWidth: "580px",
          borderRadius: "var(--ds-radius-lg)",
          boxShadow: "0 16px 40px rgba(0, 0, 0, 0.3)"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            gap: "10px"
          }}
        >
          <Search size={18} style={{ color: "var(--muted)" }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索命令、仓库或页面 (Ctrl+K)..."
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--foreground)",
              fontSize: "14px",
              fontFamily: "var(--ds-font-sans)"
            }}
          />
          <span
            style={{
              fontSize: "11px",
              color: "var(--muted)",
              background: "var(--surface-subtle)",
              padding: "2px 6px",
              borderRadius: "var(--ds-radius-sm)"
            }}
          >
            ESC
          </span>
        </div>

        <div style={{ maxHeight: "320px", overflowY: "auto", padding: "6px" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "24px", textAlign: "center", color: "var(--muted)", fontSize: "13px" }}>
              未找到匹配的命令
            </div>
          ) : (
            filtered.map((cmd, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={cmd.id}
                  onClick={() => cmd.onSelect()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderRadius: "var(--ds-radius-md)",
                    cursor: "pointer",
                    background: isSelected ? "var(--surface-subtle)" : "transparent",
                    color: isSelected ? "var(--primary)" : "var(--foreground)",
                    fontSize: "13px"
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ color: isSelected ? "var(--primary)" : "var(--muted)" }}>
                      {cmd.icon}
                    </span>
                    <span style={{ fontWeight: isSelected ? 500 : 400 }}>{cmd.title}</span>
                  </div>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--muted)",
                      background: isSelected ? "var(--surface)" : "transparent",
                      padding: "1px 6px",
                      borderRadius: "var(--ds-radius-sm)"
                    }}
                  >
                    {cmd.category}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
