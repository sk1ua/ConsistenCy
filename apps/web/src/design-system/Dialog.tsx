import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  sizeVariant?: "md" | "lg";
  className?: string;
}

export const Dialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  sizeVariant = "md",
  className = ""
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          onClose();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";

      // Focus first focusable element or dialog
      setTimeout(() => {
        const focusable = dialogRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        focusable?.focus();
      }, 50);

      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "";
        previousActiveElement.current?.focus();
      };
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="ds-dialog-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={`ds-dialog ${sizeVariant === "lg" ? "ds-dialog--lg" : ""} ${className}`.trim()}
      >
        <div className="ds-dialog-header">
          <div>
            <h2 className="ds-dialog-title">{title}</h2>
            {description && <p className="ds-dialog-description">{description}</p>}
          </div>
          <IconButton icon={<X size={16} />} label="Close" onClick={onClose} size="sm" />
        </div>

        <div className="ds-dialog-body">{children}</div>

        {footer && <div className="ds-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
};
