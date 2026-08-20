import React, { useState } from "react";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  position?: "top" | "bottom" | "left" | "right";
  delayMs?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = "top",
  delayMs = 200
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [timer, setTimer] = useState<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    const t = setTimeout(() => setIsVisible(true), delayMs);
    setTimer(t);
  };

  const handleMouseLeave = () => {
    if (timer) clearTimeout(timer);
    setIsVisible(false);
  };

  const positionStyles: React.CSSProperties = {
    position: "absolute",
    zIndex: 1000,
    background: "var(--foreground)",
    color: "var(--background)",
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "var(--ds-radius-sm)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
    ...(position === "top" && {
      bottom: "calc(100% + 4px)",
      left: "50%",
      transform: "translateX(-50%)"
    }),
    ...(position === "bottom" && {
      top: "calc(100% + 4px)",
      left: "50%",
      transform: "translateX(-50%)"
    }),
    ...(position === "left" && {
      right: "calc(100% + 4px)",
      top: "50%",
      transform: "translateY(-50%)"
    }),
    ...(position === "right" && {
      left: "calc(100% + 4px)",
      top: "50%",
      transform: "translateY(-50%)"
    })
  };

  return (
    <div
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
      {children}
      {isVisible && content && <div style={positionStyles}>{content}</div>}
    </div>
  );
};
