// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

const options: SelectMenuOption[] = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma" }
];

let host: HTMLElement | undefined;
let root: Root | undefined;
const originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  host?.remove();
  host = undefined;
  document.body.innerHTML = "";
  if (originalActEnvironmentDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironmentDescriptor);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function trigger(element: HTMLElement): HTMLButtonElement {
  return element.querySelector<HTMLButtonElement>(".ds-select-menu-trigger")!;
}

function renderedOptions(element: HTMLElement): HTMLLIElement[] {
  return [...element.querySelectorAll<HTMLLIElement>(".ds-select-menu-option")];
}

async function renderMenu(overrides: Partial<{ value: string; disabled: boolean }> = {}) {
  const onChange = vi.fn();
  await act(async () => {
    root!.render(
      <SelectMenu
        ariaLabel="Pick one"
        value={overrides.value ?? "beta"}
        options={options}
        onChange={onChange}
        disabled={overrides.disabled}
      />
    );
  });
  return { element: host!, onChange };
}

function press(element: HTMLElement, key: string) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("SelectMenu", () => {
  it("renders a closed, collapsed trigger showing the current value with listbox semantics", async () => {
    const { element } = await renderMenu();
    const button = trigger(element);

    expect(button.getAttribute("aria-label")).toBe("Pick one");
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("Beta");
    expect(element.querySelector("[role=listbox]")).toBeNull();
  });

  it("opens the popover on click, moves focus into the list, and closes with focus restored", async () => {
    const { element } = await renderMenu();
    const button = trigger(element);

    await act(async () => { button.click(); });
    const list = element.querySelector<HTMLElement>("[role=listbox]")!;
    expect(list).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(list.id);
    expect(document.activeElement).toBe(list);
    expect(renderedOptions(element)).toHaveLength(3);
    expect(element.querySelector('.ds-select-menu-option[data-value="beta"]')?.getAttribute("aria-selected")).toBe("true");
    expect(element.querySelector('.ds-select-menu-option[data-value="beta"]')?.className).toContain("is-selected");

    await act(async () => { press(list, "Escape"); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("commits a different option on click and keeps native no-change semantics on re-select", async () => {
    // Controlled harness: the parent rebinds value on change, like real usage.
    const calls: string[] = [];
    function Controlled() {
      const [value, setValue] = useState("beta");
      return (
        <SelectMenu
          ariaLabel="Pick one"
          value={value}
          options={options}
          onChange={next => { calls.push(next); setValue(next); }}
        />
      );
    }
    await act(async () => { root!.render(<Controlled />); });

    await act(async () => { trigger(host!).click(); });
    await act(async () => { host!.querySelector<HTMLLIElement>('.ds-select-menu-option[data-value="gamma"]')!.click(); });
    expect(calls).toEqual(["gamma"]);
    expect(trigger(host!).textContent).toContain("Gamma");
    expect(host!.querySelector("[role=listbox]")).toBeNull();

    await act(async () => { trigger(host!).click(); });
    await act(async () => { host!.querySelector<HTMLLIElement>('.ds-select-menu-option[data-value="gamma"]')!.click(); });
    expect(calls).toEqual(["gamma"]);
  });

  it("supports ArrowUp/ArrowDown/Enter navigation and Home/End bounds", async () => {
    const { element, onChange } = await renderMenu();
    const button = trigger(element);

    await act(async () => { button.click(); });
    const list = element.querySelector<HTMLElement>("[role=listbox]")!;

    await act(async () => { press(list, "ArrowDown"); });
    expect(element.querySelector('.ds-select-menu-option[data-value="gamma"]')?.className).toContain("is-active");

    await act(async () => { press(list, "ArrowDown"); }); // wraps to first
    expect(element.querySelector('.ds-select-menu-option[data-value="alpha"]')?.className).toContain("is-active");

    await act(async () => { press(list, "ArrowUp"); }); // wraps to last
    expect(element.querySelector('.ds-select-menu-option[data-value="gamma"]')?.className).toContain("is-active");

    await act(async () => { press(list, "Home"); });
    expect(element.querySelector('.ds-select-menu-option[data-value="alpha"]')?.className).toContain("is-active");

    await act(async () => { press(list, "End"); });
    await act(async () => { press(list, "Enter"); });
    expect(onChange).toHaveBeenCalledWith("gamma");
    expect(document.activeElement).toBe(button);
  });

  it("jumps with first-letter typeahead and commits with Space", async () => {
    const { element, onChange } = await renderMenu({ value: "alpha" });
    const button = trigger(element);

    await act(async () => { button.click(); });
    const list = element.querySelector<HTMLElement>("[role=listbox]")!;

    await act(async () => { press(list, "g"); });
    expect(element.querySelector('.ds-select-menu-option[data-value="gamma"]')?.className).toContain("is-active");
    await act(async () => { press(list, " "); });
    expect(onChange).toHaveBeenCalledWith("gamma");
  });

  it("closes on a press outside the control without firing onChange", async () => {
    const { element, onChange } = await renderMenu();
    const button = trigger(element);

    await act(async () => { button.click(); });
    expect(element.querySelector("[role=listbox]")).toBeTruthy();
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles closed when the trigger is clicked again while open", async () => {
    const { element, onChange } = await renderMenu();
    const button = trigger(element);

    await act(async () => { button.click(); });
    await act(async () => { button.click(); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes with Escape on the trigger while open and keeps focus there", async () => {
    const { element, onChange } = await renderMenu();
    const button = trigger(element);

    await act(async () => { button.click(); });
    expect(element.querySelector("[role=listbox]")).toBeTruthy();
    button.focus();
    await act(async () => { press(button, "Escape"); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not open a disabled control and keeps the trigger non-interactive", async () => {
    const { element, onChange } = await renderMenu({ disabled: true });
    const button = trigger(element);

    expect(button.disabled).toBe(true);
    await act(async () => { button.click(); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    await act(async () => { press(button, "ArrowDown"); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens from the trigger with ArrowDown and closes on Tab while open", async () => {
    const { element, onChange } = await renderMenu();
    const button = trigger(element);

    await act(async () => { press(button, "ArrowDown"); });
    expect(element.querySelector("[role=listbox]")).toBeTruthy();
    await act(async () => { press(element.querySelector<HTMLElement>("[role=listbox]")!, "Tab"); });
    expect(element.querySelector("[role=listbox]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
