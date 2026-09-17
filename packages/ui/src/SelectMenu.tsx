import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface SelectMenuOption {
  value: string;
  label: string;
}

export interface SelectMenuProps {
  /** Accessible name for the trigger button and the option list. */
  ariaLabel: string;
  /** Controlled current value (mirrors native <select> value semantics). */
  value: string;
  options: SelectMenuOption[];
  /**
   * Called when the user commits a DIFFERENT value. Like a native <select>,
   * re-picking the already-selected option fires no change.
   */
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

const TYPEAHEAD_RESET_MS = 500;

/**
 * Controlled dropdown with a styled popover listbox, replacing native
 * <select> where the popup must be styleable (ds tokens only). Keyboard
 * support: ArrowUp/Down/Home/End move the active option, Enter/Space commit,
 * Escape closes (from the list and from the open trigger), Tab dismisses,
 * first-letter typeahead jumps. A press outside the control closes the
 * popup; focus returns to the trigger on close. On open the popup flips
 * above the trigger when the viewport leaves too little room below. The
 * option click is preventDefault-ed so a wrapping <label> (e.g.
 * the Studio inspector fields) does not forward a synthetic click back to
 * the trigger and immediately reopen the popup.
 */
export function SelectMenu({ ariaLabel, value, options, onChange, disabled = false, className = "" }: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState<"down" | "up">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeaheadRef = useRef({ search: "", at: 0 });
  const listboxId = useId();
  const selectedIndex = options.findIndex(option => option.value === value);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback((index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  }, [options, value, onChange, close]);

  const openPopup = useCallback(() => {
    if (disabled || options.length === 0) return;
    typeaheadRef.current = { search: "", at: 0 };
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  // Dialog.tsx convention: opening moves focus into the surfaced content and
  // closing returns it to the opener. On open, flip the popup above the
  // trigger when the viewport leaves too little room below for the list.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    list?.focus({ preventScroll: true });
    const trigger = triggerRef.current;
    if (!trigger || !list) return;
    const triggerBox = trigger.getBoundingClientRect();
    const roomBelow = window.innerHeight - triggerBox.bottom;
    setDirection(roomBelow < list.offsetHeight && triggerBox.top > roomBelow ? "up" : "down");
  }, [open]);

  // Close on any pointer press outside the control.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: Event) => {
      if (rootRef.current?.contains(event.target as Node | null)) return;
      close(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open, close]);

  // Keep the active option visible while navigating.
  useEffect(() => {
    if (!open) return;
    const element = listRef.current?.children[activeIndex];
    if (element instanceof HTMLElement && typeof element.scrollIntoView === "function") {
      try {
        element.scrollIntoView({ block: "nearest" });
      } catch {
        // Older engines expose scrollIntoView without options.
        element.scrollIntoView();
      }
    }
  }, [open, activeIndex]);

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    const wrap = (next: number) => ((next % options.length) + options.length) % options.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(wrap(activeIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(wrap(activeIndex - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      // Let focus travel; just dismiss the popup.
      close(false);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // First-letter typeahead: jump to the next option whose label starts
      // with the accumulated search string.
      event.preventDefault();
      const now = Date.now();
      const typeahead = typeaheadRef.current;
      const search = now - typeahead.at > TYPEAHEAD_RESET_MS ? event.key : typeahead.search + event.key;
      typeaheadRef.current = { search, at: now };
      const needle = search.toLowerCase();
      for (let step = 1; step <= options.length; step += 1) {
        const index = (activeIndex + step) % options.length;
        if (options[index]!.label.toLowerCase().startsWith(needle)) {
          setActiveIndex(index);
          return;
        }
      }
    }
  };

  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex]!.label : value;

  return (
    <div ref={rootRef} className={`ds-select-menu${open ? " is-open" : ""}${className ? ` ${className}` : ""}`.trim()} data-open={open || undefined}>
      <button
        type="button"
        ref={triggerRef}
        className="ds-select-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPopup())}
        onKeyDown={event => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openPopup();
          } else if (event.key === "Escape" && open) {
            // The list usually holds focus, but an Escape landing on the
            // trigger while open (focus not yet moved, or returned by other
            // means) must still close the popup and keep focus there.
            event.preventDefault();
            close(true);
          }
        }}
      >
        <span className="ds-select-menu-value">{selectedLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={options[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
          tabIndex={-1}
          className="ds-select-menu-list"
          data-direction={direction}
          onKeyDown={handleListKeyDown}
          // Keep focus on the list while pressing an option so the click can
          // still land; also keeps the outside-press handler quiet.
          onMouseDown={event => event.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-option-${index}`}
              role="option"
              data-value={option.value}
              aria-selected={option.value === value}
              className={`ds-select-menu-option${index === activeIndex ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
              onClick={event => {
                // Cancel the label's synthetic-click forwarding (see above).
                event.preventDefault();
                commit(index);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
