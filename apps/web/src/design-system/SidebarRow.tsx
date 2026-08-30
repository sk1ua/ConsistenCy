import React from "react";
import { NavLink } from "react-router-dom";

export interface SidebarRowProps {
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

export const SidebarRow: React.FC<SidebarRowProps> = ({
  to,
  label,
  icon,
  badge,
  onClick,
  className = ""
}) => {
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={({ isActive }) =>
        `ds-sidebar-row ${isActive ? "ds-sidebar-row--active" : ""} ${className}`.trim()
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <span style={{ display: "inline-flex", color: "inherit", flexShrink: 0 }}>{icon}</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: "inherit"
          }}
        >
          {label}
        </span>
      </div>
      {badge && <div style={{ flexShrink: 0 }}>{badge}</div>}
    </NavLink>
  );
};
