import React from "react";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = <Inbox size={24} />,
  title,
  description,
  action,
  className = "",
  compact = false
}) => {
  return (
    <div
      className={`ds-empty-state ${className}`.trim()}
      style={{ padding: compact ? "16px 12px" : "28px 16px" }}
    >
      <div className="ds-empty-state-icon">{icon}</div>
      <h3 className="ds-empty-state-title">{title}</h3>
      {description && <p className="ds-empty-state-description">{description}</p>}
      {action && <div style={{ marginTop: "8px" }}>{action}</div>}
    </div>
  );
};
