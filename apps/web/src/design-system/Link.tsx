import React from "react";
import { Link, type LinkProps, useInRouterContext } from "react-router-dom";
import { ExternalLink as ExternalIcon } from "lucide-react";
import { openExternalUrl } from "../desktop";

export interface AppLinkProps extends LinkProps {
  action?: boolean;
}

export const AppLink = React.forwardRef<HTMLAnchorElement, AppLinkProps>(
  ({ children, className = "", action = false, to, ...props }, ref) => {
    let inRouter = false;
    try {
      inRouter = useInRouterContext();
    } catch {
      inRouter = false;
    }

    if (inRouter) {
      return (
        <Link
          ref={ref}
          to={to}
          className={`ds-app-link ${action ? "ds-app-link--action" : ""} ${className}`.trim()}
          {...props}
        >
          {children}
        </Link>
      );
    }

    return (
      <a
        ref={ref}
        href={typeof to === "string" ? to : ""}
        className={`ds-app-link ${action ? "ds-app-link--action" : ""} ${className}`.trim()}
        {...props}
      >
        {children}
      </a>
    );
  }
);

AppLink.displayName = "AppLink";

export interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  showIcon?: boolean;
}

export const ExternalLink: React.FC<ExternalLinkProps> = ({
  href,
  children,
  className = "",
  showIcon = true,
  onClick,
  ...props
}) => {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onClick) {
      onClick(e);
    }
    if (!e.defaultPrevented) {
      e.preventDefault();
      openExternalUrl(href);
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      target="_blank"
      rel="noopener noreferrer"
      className={`ds-external-link ${className}`.trim()}
      {...props}
    >
      {children}
      {showIcon && <ExternalIcon size={12} />}
    </a>
  );
};
