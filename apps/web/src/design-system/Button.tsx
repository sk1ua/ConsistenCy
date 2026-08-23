import React from "react";
import type { LinkProps } from "react-router-dom";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  active?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = "secondary",
      size = "md",
      loading = false,
      active = false,
      fullWidth = false,
      icon,
      disabled,
      className = "",
      ...props
    },
    ref
  ) => {
    const classNames = [
      "ds-button",
      `ds-button--${variant}`,
      `ds-button--${size}`,
      active ? "ds-button--active" : "",
      fullWidth ? "ds-button--full-width" : "",
      className
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-disabled={disabled || loading}
        className={classNames}
        {...props}
      >
        {loading ? <Loader2 size={size === "sm" ? 12 : 14} className="ds-spin" /> : icon}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";


export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
}

export const ButtonLink = React.forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  (
    {
      children,
      variant = "secondary",
      size = "md",
      active = false,
      fullWidth = false,
      icon,
      className = "",
      ...props
    },
    ref
  ) => {
    const classNames = [
      "ds-button",
      `ds-button--${variant}`,
      `ds-button--${size}`,
      active ? "ds-button--active" : "",
      fullWidth ? "ds-button--full-width" : "",
      className
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <Link ref={ref} className={classNames} {...props}>
        {icon}
        {children}
      </Link>
    );
  }
);
ButtonLink.displayName = "ButtonLink";
