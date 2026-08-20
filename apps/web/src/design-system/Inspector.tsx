import React from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

export interface InspectorProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width?: number | string;
  className?: string;
}

export const Inspector: React.FC<InspectorProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  actions,
  width = 380,
  className = ""
}) => {
  return (
    <aside
      aria-hidden={!isOpen}
      className={`ds-inspector ${isOpen ? "ds-inspector--open" : "ds-inspector--closed"} ${className}`.trim()}
      style={{ width: isOpen ? (typeof width === "number" ? `${width}px` : width) : 0 }}
    >
      {isOpen && (
        <>
          <div className="ds-inspector-header">
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <div className="ds-inspector-title">{title}</div>
              {subtitle && (
                <div style={{ fontSize: "11px", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {subtitle}
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              {actions}
              <IconButton icon={<X size={14} />} label="Close Inspector" onClick={onClose} size="sm" />
            </div>
          </div>
          <div className="ds-inspector-content">{children}</div>
        </>
      )}
    </aside>
  );
};
