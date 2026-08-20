import React from "react";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: React.ReactNode;
  description?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, description, className = "", id, ...props }, ref) => {
    const inputId = id ?? (typeof label === "string" ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    if (!label && !description) {
      return (
        <input
          ref={ref}
          type="checkbox"
          id={inputId}
          className={`ds-checkbox ${className}`.trim()}
          {...props}
        />
      );
    }

    return (
      <label htmlFor={inputId} className="ds-checkbox-label">
        <input
          ref={ref}
          type="checkbox"
          id={inputId}
          className={`ds-checkbox ${className}`.trim()}
          {...props}
        />
        <div style={{ display: "flex", flexDirection: "column" }}>
          {label && <span>{label}</span>}
          {description && <span style={{ fontSize: 11, color: "var(--muted)" }}>{description}</span>}
        </div>
      </label>
    );
  }
);

Checkbox.displayName = "Checkbox";
