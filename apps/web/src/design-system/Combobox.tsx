import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

export interface ComboboxOption {
  label: string;
  value: string;
  description?: string;
  badge?: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const Combobox: React.FC<ComboboxProps> = ({
  options,
  value,
  onChange,
  placeholder = "Select an option...",
  disabled = false,
  className = ""
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isOpen]);

  const filtered = query.trim()
    ? options.filter(
        opt =>
          opt.label.toLowerCase().includes(query.toLowerCase()) ||
          opt.value.toLowerCase().includes(query.toLowerCase()) ||
          opt.description?.toLowerCase().includes(query.toLowerCase())
      )
    : options;

  return (
    <div
      ref={containerRef}
      className={`ds-combobox ${className}`.trim()}
      style={{ position: "relative", width: "100%" }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="ds-input"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: disabled ? "not-allowed" : "pointer",
          textAlign: "left"
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedOption ? selectedOption.label : <span style={{ color: "var(--muted)" }}>{placeholder}</span>}
        </span>
        <ChevronDown size={14} style={{ color: "var(--muted)", flexShrink: 0, marginLeft: 6 }} />
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 100,
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--ds-radius-md)",
            boxShadow: "0 6px 16px rgba(0,0,0,0.15)",
            maxHeight: "240px",
            overflowY: "auto",
            padding: "4px"
          }}
        >
          {options.length > 5 && (
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search..."
              autoFocus
              className="ds-input ds-input--sm"
              style={{ marginBottom: "4px" }}
              onClick={e => e.stopPropagation()}
            />
          )}
          {filtered.length === 0 ? (
            <div style={{ padding: "8px 12px", color: "var(--muted)", fontSize: 12, textAlign: "center" }}>
              No matches found
            </div>
          ) : (
            filtered.map(opt => {
              const isSelected = opt.value === value;
              return (
                <div
                  key={opt.value}
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                    setQuery("");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: "var(--ds-radius-sm)",
                    cursor: "pointer",
                    fontSize: 13,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    background: isSelected ? "var(--surface-subtle)" : "transparent",
                    color: isSelected ? "var(--primary)" : "var(--foreground)"
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.background = "var(--surface-subtle)";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = isSelected
                      ? "var(--surface-subtle)"
                      : "transparent";
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: isSelected ? 600 : 400 }}>{opt.label}</span>
                    {opt.description && (
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{opt.description}</span>
                    )}
                  </div>
                  {isSelected && <Check size={14} color="var(--primary)" />}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
