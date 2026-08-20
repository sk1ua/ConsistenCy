import React from "react";
import { ChevronRight } from "lucide-react";
import { AppLink } from "./Link";

export interface BreadcrumbItem {
  label: React.ReactNode;
  to?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ items, className = "" }) => {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`ds-breadcrumb ${className}`.trim()}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "13px",
        color: "var(--muted)"
      }}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <React.Fragment key={index}>
            {index > 0 && (
              <ChevronRight size={12} style={{ color: "var(--border-strong)", flexShrink: 0 }} />
            )}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontWeight: isLast ? 600 : 400,
                color: isLast ? "var(--foreground)" : "var(--muted)"
              }}
            >
              {item.icon}
              {item.to && !isLast ? (
                <AppLink to={item.to} style={{ color: "inherit" }}>
                  {item.label}
                </AppLink>
              ) : item.onClick && !isLast ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    color: "inherit",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center"
                  }}
                >
                  {item.label}
                </button>
              ) : (
                <span>{item.label}</span>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </nav>
  );
};
