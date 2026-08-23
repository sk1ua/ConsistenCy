import React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  sizeVariant?: "sm" | "md";
  mono?: boolean;
  prefixIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      sizeVariant = "md",
      mono = false,
      prefixIcon,
      className = "",
      ...props
    },
    ref
  ) => {
    const inputClasses = [
      "ds-input",
      `ds-input--${sizeVariant}`,
      mono ? "ds-badge--mono" : "",
      prefixIcon ? "ds-input--has-prefix" : "",
      className
    ]
      .filter(Boolean)
      .join(" ");

    if (prefixIcon) {
      return (
        <div className="ds-input-wrapper">
          <div className="ds-input-prefix">{prefixIcon}</div>
          <input ref={ref} className={inputClasses} {...props} />
        </div>
      );
    }

    return <input ref={ref} className={inputClasses} {...props} />;
  }
);

Input.displayName = "Input";
