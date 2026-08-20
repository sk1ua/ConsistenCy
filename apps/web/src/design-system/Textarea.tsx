import React from "react";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  error?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ mono = false, error = false, className = "", ...props }, ref) => {
    const classNames = [
      "ds-textarea",
      mono ? "ds-input--mono" : "",
      error ? "ds-input--error" : "",
      className
    ]
      .filter(Boolean)
      .join(" ");

    return <textarea ref={ref} className={classNames} {...props} />;
  }
);

Textarea.displayName = "Textarea";
