// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { readThemePreference, resolveTheme, ThemeProvider } from "./theme";

const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
let clientRoot: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (clientRoot) await act(async () => { clientRoot!.unmount(); });
  clientRoot = undefined;
  document.body.innerHTML = "";
  if (originalMatchMediaDescriptor) Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
  else Reflect.deleteProperty(window, "matchMedia");
  if (originalLocalStorageDescriptor) Object.defineProperty(window, "localStorage", originalLocalStorageDescriptor);
  else Reflect.deleteProperty(window, "localStorage");
});

describe("resolveTheme", () => {
  it("resolves the system preference from the OS signal", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("follows OS changes while the preference remains system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("resolves explicit preferences regardless of the OS signal", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("keeps explicit preferences stable across OS changes", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("reads the persisted preference and defaults to system", () => {
    expect(readThemePreference({ getItem: () => null })).toBe("system");
    expect(readThemePreference({ getItem: () => "light" })).toBe("light");
    expect(readThemePreference({ getItem: () => "dark" })).toBe("dark");
    expect(readThemePreference({ getItem: () => "invalid" })).toBe("system");
    expect(readThemePreference({} as Pick<Storage, "getItem">)).toBe("system");
    expect(readThemePreference({ getItem: undefined } as unknown as Pick<Storage, "getItem">)).toBe("system");
    expect(readThemePreference({ getItem: () => { throw new Error("storage unavailable"); } })).toBe("system");
  });

  it("returns system when the window localStorage getter throws", () => {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
    expect(readThemePreference()).toBe("system");
  });
});

describe("ThemeProvider", () => {
  it("renders children without a DOM environment", () => {
    const html = renderToString(
      <ThemeProvider><div>theme-child</div></ThemeProvider>
    );
    expect(html).toContain("theme-child");
  });

  it("does not crash when matchMedia is unavailable", async () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    const host = document.createElement("div"); document.body.append(host); clientRoot = createRoot(host);
    await act(async () => { clientRoot!.render(<ThemeProvider><div>theme-child</div></ThemeProvider>); });
    expect(host.textContent).toContain("theme-child");
  });

  it("does not crash when localStorage has no getItem or setItem", async () => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: {} });
    const host = document.createElement("div"); document.body.append(host); clientRoot = createRoot(host);
    await act(async () => { clientRoot!.render(<ThemeProvider><div>theme-child</div></ThemeProvider>); });
    expect(host.textContent).toContain("theme-child");
  });

  it("silently ignores localStorage getItem and setItem failures", async () => {
    const setItem = vi.fn(() => { throw new Error("quota"); });
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => { throw new Error("denied"); }, setItem } });
    expect(readThemePreference()).toBe("system");
    const host = document.createElement("div"); document.body.append(host); clientRoot = createRoot(host);
    await act(async () => { clientRoot!.render(<ThemeProvider><div>theme-child</div></ThemeProvider>); });
    expect(host.textContent).toContain("theme-child");
    expect(setItem).toHaveBeenCalled();
  });

  it("persists the preference when localStorage is available", async () => {
    const setItem = vi.fn();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => "dark", setItem } });
    const host = document.createElement("div"); document.body.append(host); clientRoot = createRoot(host);
    await act(async () => { clientRoot!.render(<ThemeProvider><div>theme-child</div></ThemeProvider>); });
    expect(setItem).toHaveBeenCalledWith("consistency.theme.v1", "dark");
  });

  it("registers and removes one modern matchMedia listener", async () => {
    const addEventListener = vi.fn(); const removeEventListener = vi.fn();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener, removeEventListener }) });
    const host = document.createElement("div"); document.body.append(host); clientRoot = createRoot(host);
    await act(async () => { clientRoot!.render(<ThemeProvider><div>theme-child</div></ThemeProvider>); });
    expect(addEventListener).toHaveBeenCalledOnce();
    await act(async () => { clientRoot!.unmount(); }); clientRoot = undefined;
    expect(removeEventListener).toHaveBeenCalledWith("change", addEventListener.mock.calls[0]![1]);
  });

  it("registers and removes one legacy matchMedia listener", async () => {
    const addListener = vi.fn(); const removeListener = vi.fn();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener, removeListener }) });
    const host = document.createElement("div"); document.body.append(host); clientRoot = createRoot(host);
    await act(async () => { clientRoot!.render(<ThemeProvider><div>theme-child</div></ThemeProvider>); });
    expect(addListener).toHaveBeenCalledOnce();
    await act(async () => { clientRoot!.unmount(); }); clientRoot = undefined;
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0]![0]);
  });
});

describe("anti-flash script", () => {
  it("uses the same localStorage key as ThemeProvider", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
    const bootstrap = readFileSync(join(here, "..", "public", "theme-bootstrap.js"), "utf8");
    expect(indexHtml).toContain('src="/theme-bootstrap.js"');
    expect(bootstrap).toContain('"consistency.theme.v1"');
    expect(indexHtml).not.toContain("<script>");
  });
});
