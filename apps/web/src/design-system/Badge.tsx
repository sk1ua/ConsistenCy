import React from "react";

export type BadgeVariant =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "running"
  | "succeeded"
  | "failed";

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  dot?: boolean;
  mono?: boolean;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}

function normalizeVariant(variant: BadgeVariant): "neutral" | "primary" | "success" | "warning" | "danger" {
  switch (variant) {
    case "critical":
    case "danger":
    case "failed":
      return "danger";
    case "high":
    case "warning":
    case "running":
      return "warning";
    case "medium":
    case "primary":
      return "primary";
    case "low":
    case "success":
    case "succeeded":
      return "success";
    case "neutral":
    default:
      return "neutral";
  }
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "neutral",
  dot = false,
  mono = false,
  size = "md",
  className = "",
  title
}) => {
  const normalized = normalizeVariant(variant);
  const classNames = [
    "ds-badge",
    `ds-badge--${normalized}`,
    size === "sm" ? "ds-badge--sm" : "",
    mono ? "ds-badge--mono" : "",
    className
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classNames} title={title}>
      {dot && <span className="ds-badge-dot" />}
      {children}
    </span>
  );
};
