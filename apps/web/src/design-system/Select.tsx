import React from "react";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  sizeVariant?: "sm" | "md";
  options?: Array<{ label: string; value: string; disabled?: boolean }>;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ sizeVariant = "md", options, children, className = "", ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={`ds-select ds-select--${sizeVariant} ${className}`.trim()}
        {...props}
      >
        {options
          ? options.map(opt => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))
          : children}
      </select>
    );
  }
);

Select.displayName = "Select";
