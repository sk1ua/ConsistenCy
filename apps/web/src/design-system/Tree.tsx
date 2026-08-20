import React, { useState } from "react";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from "lucide-react";

export interface TreeNode {
  id: string;
  name: string;
  isFolder?: boolean;
  children?: TreeNode[];
  badge?: React.ReactNode;
  icon?: React.ReactNode;
  data?: any;
}

export interface TreeProps {
  nodes: TreeNode[];
  selectedId?: string;
  onSelectNode: (node: TreeNode) => void;
  defaultExpandedIds?: string[];
  className?: string;
}

const TreeItem: React.FC<{
  node: TreeNode;
  selectedId?: string;
  onSelectNode: (node: TreeNode) => void;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  level: number;
}> = ({ node, selectedId, onSelectNode, expandedIds, toggleExpand, level }) => {
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const isFolder = Boolean(node.isFolder || (node.children && node.children.length > 0));

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        onClick={() => {
          if (isFolder) {
            toggleExpand(node.id);
          }
          onSelectNode(node);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `4px 8px 4px ${8 + level * 14}px`,
          cursor: "pointer",
          borderRadius: "var(--ds-radius-sm)",
          fontSize: "12px",
          fontFamily: "var(--ds-font-mono)",
          background: isSelected ? "var(--surface-subtle)" : "transparent",
          color: isSelected ? "var(--primary)" : "var(--foreground)",
          fontWeight: isSelected ? 600 : 400,
          userSelect: "none"
        }}
        onMouseEnter={e => {
          if (!isSelected) (e.currentTarget as HTMLElement).style.background = "var(--surface-subtle)";
        }}
        onMouseLeave={e => {
          if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
          {isFolder ? (
            <span
              onClick={e => {
                e.stopPropagation();
                toggleExpand(node.id);
              }}
              style={{ display: "inline-flex", color: "var(--muted)", cursor: "pointer" }}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : (
            <span style={{ width: 14 }} />
          )}

          <span style={{ color: "var(--muted-strong)", display: "inline-flex" }}>
            {node.icon ? (
              node.icon
            ) : isFolder ? (
              isExpanded ? (
                <FolderOpen size={14} color="var(--warning)" />
              ) : (
                <Folder size={14} color="var(--warning)" />
              )
            ) : (
              <File size={14} />
            )}
          </span>

          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.name}
          </span>
        </div>

        {node.badge && <div>{node.badge}</div>}
      </div>

      {isFolder && isExpanded && node.children && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {node.children.map(child => (
            <TreeItem
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelectNode={onSelectNode}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const Tree: React.FC<TreeProps> = ({
  nodes,
  selectedId,
  onSelectNode,
  defaultExpandedIds = [],
  className = ""
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(defaultExpandedIds));

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className={`ds-tree ${className}`.trim()} style={{ display: "flex", flexDirection: "column" }}>
      {nodes.map(node => (
        <TreeItem
          key={node.id}
          node={node}
          selectedId={selectedId}
          onSelectNode={onSelectNode}
          expandedIds={expandedIds}
          toggleExpand={toggleExpand}
          level={0}
        />
      ))}
    </div>
  );
};
