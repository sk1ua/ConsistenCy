import React, { useState, useRef, useEffect } from "react";

export interface MenuItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface DropdownMenuProps {
  trigger: React.ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  className?: string;
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  trigger,
  items,
  align = "right",
  className = ""
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

  return (
    <div
      ref={menuRef}
      className={`ds-dropdown-container ${className}`.trim()}
      style={{ position: "relative", display: "inline-block" }}
    >
      <div onClick={() => setIsOpen(!isOpen)} style={{ display: "inline-flex" }}>
        {trigger}
      </div>

      {isOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            [align === "right" ? "right" : "left"]: 0,
            zIndex: 100,
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--ds-radius-md)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            minWidth: "160px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            gap: "2px"
          }}
        >
          {items.map(item => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => {
                item.onClick();
                setIsOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                width: "100%",
                padding: "6px 10px",
                fontSize: "13px",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderRadius: "var(--ds-radius-sm)",
                color: item.danger ? "var(--danger)" : "var(--foreground)",
                cursor: item.disabled ? "not-allowed" : "pointer",
                opacity: item.disabled ? 0.4 : 1
              }}
              onMouseEnter={e => {
                if (!item.disabled) {
                  (e.currentTarget as HTMLElement).style.background = item.danger
                    ? "var(--danger-soft)"
                    : "var(--surface-subtle)";
                }
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
