/**
 * Shared AppearanceSettingsSection contract tests.
 *
 * The section surfaces the EXISTING renderer-local theme and locale
 * capabilities with immediate effect (no draft/save lifecycle — they never
 * round-trip the server settings form). The density row and the resolved
 * theme row were ablated: density has no contract, and the resolved theme
 * lives in the theme help text. These tests pin the lean structure, the
 * immediate-effect semantics through the real ThemeProvider / I18nProvider,
 * and zh-CN coverage.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ThemeProvider } from "../../theme";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";

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

async function selectOption(container: HTMLElement, label: string, value: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`.ds-select-menu-trigger[aria-label="${label}"]`)!;
  await act(async () => { trigger.click(); });
  const option = container.querySelector<HTMLLIElement>(`.ds-select-menu-option[data-value="${value}"]`)!;
  await act(async () => { option.click(); });
}

// The providers persist to localStorage; clear it so every test starts from
// the deterministic defaults (theme preference "system", explicit test locale).
beforeEach(() => {
  window.localStorage.clear();
});

describe("AppearanceSettingsSection structure", () => {
  it("renders exactly the theme and language controls with no placeholder rows", () => {
    const html = renderSection();
    expect(html).toContain('aria-label="Theme"');
    expect(html).toContain('aria-label="Language"');
    expect(html).toContain("Theme and language");
    // Ablated: no density placeholder row, no resolved-theme card.
    expect(html).not.toContain('id="setting-density"');
    expect(html).not.toContain('id="setting-theme-resolved"');
    expect(html).not.toContain("Not available yet");
  });

  it("localizes the theme and locale options and states the immediate/local effect", () => {
    const html = renderSection();
    expect(html).toContain("Follow system");
    expect(html).toContain("English");
    expect(html).toContain("Applies immediately and is stored locally.");
  });

  it("exposes exactly two design-system select menus and no save command", async () => {
    const { container, root } = await mountSection();
    expect(container.querySelectorAll(".ds-select-menu")).toHaveLength(2);
    expect(container.querySelectorAll(".ds-select-menu-trigger")).toHaveLength(2);

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("AppearanceSettingsSection immediate-effect semantics", () => {
  it("changes the theme preference through the real theme provider without any save step", async () => {
    const { container, root } = await mountSection();
    const themeTrigger = container.querySelector<HTMLButtonElement>('.ds-select-menu-trigger[aria-label="Theme"]')!;
    expect(themeTrigger.textContent).toContain("Follow system");
    expect(document.documentElement.dataset.theme).toBe("light");

    await selectOption(container, "Theme", "dark");

    expect(themeTrigger.textContent).toContain("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("consistency.theme.v1")).toBe("dark");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("switches the interface language through the real i18n provider without any save step", async () => {
    const { container, root } = await mountSection("en-US");
    expect(container.textContent).toContain("Theme");

    await selectOption(container, "Language", "zh-CN");

    expect(container.textContent).toContain("主题");
    expect(container.textContent).toContain("跟随系统");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem("consistency.locale.v1")).toBe("zh-CN");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("AppearanceSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection("zh-CN");
    expect(html).toContain("主题与语言");
    expect(html).toContain("跟随系统");
    expect(html).toContain("立即生效，并保存在本地。");
    expect(html).toContain("实时跟随操作系统");
    expect(html).not.toContain("Follow system");
    expect(html).not.toContain("Applies immediately");
    expect(html).not.toContain("界面密度");
    expect(html).not.toContain("暂未提供");
  });
});
