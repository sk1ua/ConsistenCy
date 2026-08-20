import React from "react";

export interface RadioOption {
  label: React.ReactNode;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export const RadioGroup: React.FC<RadioGroupProps> = ({
  name,
  options,
  value,
  onChange,
  disabled = false,
  className = ""
}) => {
  return (
    <div
      className={`ds-radio-group ${className}`.trim()}
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      {options.map(option => {
        const optionId = `${name}-${option.value}`;
        const isSelected = option.value === value;
        const isDisabled = disabled || option.disabled;

        return (
          <label
            key={option.value}
            htmlFor={optionId}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              cursor: isDisabled ? "not-allowed" : "pointer",
              opacity: isDisabled ? 0.5 : 1
            }}
          >
            <input
              type="radio"
              id={optionId}
              name={name}
              value={option.value}
              checked={isSelected}
              disabled={isDisabled}
              onChange={() => onChange(option.value)}
              style={{
                marginTop: "3px",
                accentColor: "var(--primary)",
                cursor: isDisabled ? "not-allowed" : "pointer"
              }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "13px", fontWeight: isSelected ? 500 : 400, color: "var(--foreground)" }}>
                {option.label}
              </span>
              {option.description && (
                <span style={{ fontSize: "11px", color: "var(--muted)", marginTop: "2px" }}>
                  {option.description}
                </span>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
};
