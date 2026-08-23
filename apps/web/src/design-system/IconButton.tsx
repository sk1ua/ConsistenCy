import React from "react";
import { Loader2 } from "lucide-react";

export type IconButtonVariant = "ghost" | "outline" | "secondary";
export type IconButtonSize = "sm" | "md";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  active?: boolean;
  loading?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon,
      label,
      variant = "ghost",
      size = "md",
      active = false,
      loading = false,
      disabled,
      className = "",
      ...props
    },
    ref
  ) => {
    const classNames = [
      "ds-icon-button",
      `ds-icon-button--${variant}`,
      `ds-icon-button--${size}`,
      active ? "ds-icon-button--active" : "",
      className
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        disabled={disabled || loading}
        aria-pressed={active}
        className={classNames}
        {...props}
      >
        {loading ? <Loader2 size={12} className="ds-spin" /> : icon}
      </button>
    );
  }
);

IconButton.displayName = "IconButton";
