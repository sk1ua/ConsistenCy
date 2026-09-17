import React from "react";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  icon?: React.ReactNode | null;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className = "",
  compact = false
}) => {
  const resolvedIcon = icon === null ? null : (icon ?? <Inbox size={compact ? 18 : 22} />);
  return (
    <div
      className={`ds-empty-state ${compact ? "ds-empty-state--compact" : ""} ${className}`.trim()}
      style={{ padding: compact ? "18px 8px" : "32px 16px" }}
    >
      {resolvedIcon != null && <div className="ds-empty-state-icon">{resolvedIcon}</div>}
      <h3 className="ds-empty-state-title">{title}</h3>
      {description && <p className="ds-empty-state-description">{description}</p>}
      {action && <div style={{ marginTop: "8px" }}>{action}</div>}
    </div>
  );
};
