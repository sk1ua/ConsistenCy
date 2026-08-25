/**
 * Shared AppearanceSettingsSection contract tests for CKPT4 Slice 3.
 *
 * The section surfaces the EXISTING renderer-local theme and locale
 * capabilities with immediate effect (no draft/save lifecycle — they never
 * round-trip the server settings form) and displays Density truthfully as
 * not-yet-available with no fake control. These tests pin the stable element
 * ids, the immediate-effect semantics through the real ThemeProvider /
 * I18nProvider, the resolved-theme truth row, and zh-CN coverage for every
 * new user-visible string.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ThemeProvider } from "../../theme";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";

// happy-dom reports prefers-color-scheme: dark as unmatched, so the resolved
// theme under the "system" preference is deterministic: light.
function renderSection(locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <I18nProvider initialLocale={locale}>
        <AppearanceSettingsSection />
      </I18nProvider>
    </ThemeProvider>
  );
}

async function mountSection(initialLocale: "en-US" | "zh-CN" = "en-US") {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider>
        <I18nProvider initialLocale={initialLocale}>
          <AppearanceSettingsSection />
        </I18nProvider>
      </ThemeProvider>
    );
  });
  return { container, root };
}

function selectOption(container: HTMLElement, id: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`#${id}`)!;
  // Bypass React's instance-level value tracker so the native change event is
  // observed as a real controlled change (same approach as the editable-field
  // tests in RuntimeSettingsSection.test.tsx).
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

// The providers persist to localStorage; clear it so every test starts from
// the deterministic defaults (theme preference "system", explicit test locale).
beforeEach(() => {
  window.localStorage.clear();
});

describe("AppearanceSettingsSection structure", () => {
  it("renders the stable field ids for theme, locale, resolved theme and density", () => {
    const html = renderSection();
    expect(html).toContain('id="setting-theme"');
    expect(html).toContain('id="setting-locale"');
    expect(html).toContain('id="setting-theme-resolved"');
    expect(html).toContain('id="setting-density"');
    expect(html).toContain("04 · Appearance");
    expect(html).toContain("Theme and language");
  });

  it("localizes the theme and locale options and states the immediate/local effect", () => {
    const html = renderSection();
    expect(html).toMatch(/<option value="system"[^>]*>Follow system<\/option>/);
    expect(html).toMatch(/<option value="light"[^>]*>Light<\/option>/);
    expect(html).toMatch(/<option value="dark"[^>]*>Dark<\/option>/);
    expect(html).toMatch(/<option value="zh-CN"[^>]*>中文<\/option>/);
    expect(html).toMatch(/<option value="en-US"[^>]*>English<\/option>/);
    expect(html).toContain("Applies immediately and is stored locally.");
  });

  it("shows the resolved theme truthfully for the system preference", () => {
    const html = renderSection();
    expect(html).toContain("Resolved theme");
    // system preference + happy-dom light OS signal → resolved light.
    expect(html).toContain("Currently Light (following the system setting)");
  });

  it("renders density as a read-only not-available row with no fake control", () => {
    const html = renderSection();
    expect(html).toContain("Density");
    expect(html).toContain("Not available yet");
    expect(html).toContain("No density contract exists yet, so no option is offered.");
  });

  it("exposes exactly two interactive selects and no button (no save lifecycle inside the section)", async () => {
    const { container, root } = await mountSection();
    expect(container.querySelectorAll("select")).toHaveLength(2);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    const densityRow = container.querySelector("#setting-density")!;
    expect(densityRow).toBeTruthy();
    expect(densityRow.querySelector("select, input, button, textarea")).toBeNull();

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("AppearanceSettingsSection immediate-effect semantics", () => {
  it("changes the theme preference through the real theme provider without any save step", async () => {
    const { container, root } = await mountSection();
    const themeSelect = container.querySelector<HTMLSelectElement>("#setting-theme")!;
    expect(themeSelect.value).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => { selectOption(container, "setting-theme", "dark"); });

    expect(themeSelect.value).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("consistency.theme.v1")).toBe("dark");
    // Forced preference: resolved row follows without the system qualifier.
    expect(container.querySelector("#setting-theme-resolved")?.textContent).toContain("Currently Dark");
    expect(container.querySelector("#setting-theme-resolved")?.textContent).not.toContain("following the system setting");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("switches the interface language through the real i18n provider without any save step", async () => {
    const { container, root } = await mountSection("en-US");
    expect(container.querySelector('label[for="setting-theme"]')?.textContent).toBe("Theme");

    await act(async () => { selectOption(container, "setting-locale", "zh-CN"); });

    expect(container.querySelector<HTMLSelectElement>("#setting-locale")?.value).toBe("zh-CN");
    expect(container.querySelector('label[for="setting-theme"]')?.textContent).toBe("主题");
    expect(container.querySelector("#setting-theme")?.textContent).toContain("跟随系统");
    expect(container.querySelector("#setting-density")?.textContent).toContain("暂未提供");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem("consistency.locale.v1")).toBe("zh-CN");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("AppearanceSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection("zh-CN");
    expect(html).toContain("04 · 外观");
    expect(html).toContain("主题与语言");
    expect(html).toContain("跟随系统");
    expect(html).toContain("立即生效，并保存在本地。");
    expect(html).toContain("当前生效主题");
    expect(html).toContain("当前生效：浅色（跟随系统）");
    expect(html).toContain("界面密度");
    expect(html).toContain("暂未提供");
    expect(html).toContain("界面密度尚未定义契约，因此暂不提供选项。");
    expect(html).not.toContain("Follow system");
    expect(html).not.toContain("Not available yet");
    expect(html).not.toContain("Currently Light");
    expect(html).not.toContain("Density");
  });
});
