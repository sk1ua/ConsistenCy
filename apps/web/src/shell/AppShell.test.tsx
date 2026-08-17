import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell, isCommandPaletteShortcut, nextWorkbenchTabId } from "./AppShell";

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function renderShell(path = "/runs"): string {
  return renderToString(<MemoryRouter initialEntries={[path]}><AppShell
    path={path}
    routeHref={path}
    meta={{ title: "Audit runs", shortTitle: "Runs", description: "Review runs", section: "Reviews" }}
    locale="en-US"
    setLocale={() => undefined}
    themePreference="dark"
    themeLabel="Dark"
    cycleTheme={() => undefined}
    jobs={[]}
    pulse={null}
    healthUnavailable={false}
    demoMode={false}
    notices={[]}
    refreshing={false}
    canSeedDemo={false}
    seedingDemo={false}
    onRefresh={() => undefined}
    onSeedDemo={() => undefined}
  ><p>Route content</p></AppShell></MemoryRouter>);
}

describe("Workbench tabs", () => {
  it("connects a horizontal tablist to one labelled tabpanel with roving tabindex", () => {
    const html = renderShell();
    const tablist = html.match(/<div(?=[^>]*role="tablist")[^>]*>/)?.[0];
    const tabs = html.match(/<a(?=[^>]*role="tab")[^>]*>/g) ?? [];
    const panel = html.match(/<div(?=[^>]*role="tabpanel")[^>]*>/)?.[0];

    expect(tablist).toContain('aria-orientation="horizontal"');
    expect(tabs).toHaveLength(2);
    expect(attribute(tabs[0]!, "aria-selected")).toBe("false");
    expect(attribute(tabs[0]!, "tabindex")).toBe("-1");
    expect(attribute(tabs[1]!, "aria-selected")).toBe("true");
    expect(attribute(tabs[1]!, "tabindex")).toBe("0");
    expect(attribute(tabs[0]!, "aria-controls")).toBe(attribute(panel!, "id"));
    expect(attribute(tabs[1]!, "aria-controls")).toBe(attribute(panel!, "id"));
    expect(attribute(panel!, "aria-labelledby")).toBe(attribute(tabs[1]!, "id"));
    expect(attribute(panel!, "tabindex")).toBe("0");
  });

  it("supports wrapped horizontal arrows plus Home and End", () => {
    const tabs = ["inbox", "current"] as const;

    expect(nextWorkbenchTabId(tabs, "inbox", "ArrowRight")).toBe("current");
    expect(nextWorkbenchTabId(tabs, "current", "ArrowRight")).toBe("inbox");
    expect(nextWorkbenchTabId(tabs, "inbox", "ArrowLeft")).toBe("current");
    expect(nextWorkbenchTabId(tabs, "current", "Home")).toBe("inbox");
    expect(nextWorkbenchTabId(tabs, "inbox", "End")).toBe("current");
    expect(nextWorkbenchTabId(tabs, "inbox", "ArrowDown")).toBeUndefined();
    expect(nextWorkbenchTabId(tabs, "inbox", "Tab")).toBeUndefined();
  });

  it("reserves Ctrl/Command K and P for the workspace command palette", () => {
    const event = (key: string, overrides: Partial<Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {}) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides
    });

    expect(isCommandPaletteShortcut(event("k", { ctrlKey: true }))).toBe(true);
    expect(isCommandPaletteShortcut(event("P", { metaKey: true }))).toBe(true);
    expect(isCommandPaletteShortcut(event("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCommandPaletteShortcut(event("p"))).toBe(false);
  });
});
