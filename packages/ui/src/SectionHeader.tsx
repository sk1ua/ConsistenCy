import React from "react";

export interface SectionHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  subtitle,
  icon,
  actions,
  className = ""
}) => {
  return (
    <div className={`ds-section-header ${className}`.trim()}>
      <div>
        <h2 className="ds-section-title">
          {icon && <span style={{ color: "var(--primary)", display: "inline-flex" }}>{icon}</span>}
          <span>{title}</span>
        </h2>
        {subtitle && (
          <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="ds-section-actions">{actions}</div>}
    </div>
  );
};
