import React from "react";

export interface TabItem {
  id: string;
  label: React.ReactNode;
  count?: number;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: "line" | "pills";
  className?: string;
  ariaLabel?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeId,
  onChange,
  variant = "line",
  className = "",
  ariaLabel = "Navigation tabs"
}) => {
  return (
    <nav
      aria-label={ariaLabel}
      className={`ds-tabs-nav ${variant === "pills" ? "ds-tabs-nav--pills" : ""} ${className}`.trim()}
    >
      {tabs.map(tab => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={`ds-tab-button ${isActive ? "ds-tab-button--active" : ""}`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "9999px",
                  background: isActive ? "var(--primary-soft)" : "var(--surface-subtle)",
                  color: isActive ? "var(--primary-strong)" : "var(--muted)",
                  fontWeight: 600
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
};
