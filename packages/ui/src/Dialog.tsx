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
  className?: string;
  dismissible?: boolean;
}

export const Dialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  className = "",
  dismissible = true
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && dismissible) {
          onClose();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";

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
  }, [isOpen, onClose, dismissible]);

  if (!isOpen) return null;

  return (
    <div
      className="ds-dialog-overlay"
      onClick={e => {
        if (e.target === e.currentTarget && dismissible) {
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
        className={`ds-dialog ${className}`.trim()}
      >
        <div className="ds-dialog-header">
          <div>
            <h2 className="ds-dialog-title">{title}</h2>
            {description && <p className="ds-dialog-description">{description}</p>}
          </div>
          <IconButton icon={<X size={15} />} label="Close" onClick={onClose} size="sm" disabled={!dismissible} />
        </div>

        <div className="ds-dialog-body">{children}</div>

        {footer && <div className="ds-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
};
