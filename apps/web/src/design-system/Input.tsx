import React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  sizeVariant?: "sm" | "md";
  mono?: boolean;
  prefixIcon?: React.ReactNode;
  suffixIcon?: React.ReactNode;
  error?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      sizeVariant = "md",
      mono = false,
      prefixIcon,
      suffixIcon,
      error = false,
      className = "",
      ...props
    },
    ref
  ) => {
    const inputClasses = [
      "ds-input",
      `ds-input--${sizeVariant}`,
      mono ? "ds-input--mono" : "",
      prefixIcon ? "ds-input--has-prefix" : "",
      suffixIcon ? "ds-input--has-suffix" : "",
      error ? "ds-input--error" : "",
      className
    ]
      .filter(Boolean)
      .join(" ");

    if (prefixIcon || suffixIcon) {
      return (
        <div className="ds-input-wrapper">
          {prefixIcon && <div className="ds-input-prefix">{prefixIcon}</div>}
          <input ref={ref} className={inputClasses} {...props} />
          {suffixIcon && <div className="ds-input-suffix">{suffixIcon}</div>}
        </div>
      );
    }

    return <input ref={ref} className={inputClasses} {...props} />;
  }
);

Input.displayName = "Input";
