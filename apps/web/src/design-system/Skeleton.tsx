import React from "react";

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: React.CSSProperties;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width = "100%",
  height = "16px",
  borderRadius = "var(--ds-radius-sm)",
  className = "",
  style
}) => {
  return (
    <div
      className={`ds-skeleton ${className}`.trim()}
      style={{
        width,
        height,
        borderRadius,
        background: "var(--surface-subtle)",
        animation: "ds-pulse 1.5s ease-in-out infinite",
        ...style
      }}
    />
  );
};
