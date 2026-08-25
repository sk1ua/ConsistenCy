/**
 * Shared DesktopSettingsSection contract tests for CKPT4 Slice 4.
 *
 * The section is a READ_ONLY_STATUS presentation of the Electron host's
 * fixed, documented behaviors: close hides to an always-present tray,
 * startup-at-login stays off under the current security model, and no
 * notification system exists. These tests pin the stable element ids, the
 * absence of ANY interactive control (no fake toggles), the truthful
 * browser-mode degradation (no desktop bridge in the default test
 * environment), the bridge-present variant, and zh-CN coverage for every
 * user-visible string.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { DesktopSettingsSection } from "./DesktopSettingsSection";

// The default test environment exposes no window.consistencyDesktop, so the
// section renders its browser-mode degradation by default.
function renderSection(locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <DesktopSettingsSection />
    </I18nProvider>
  );
}

function installBridge() {
  // The section only checks bridge presence (it calls no bridge method), so a
  // presence-only stub stands in for the preload surface; the unknown cast
  // keeps the global ConsistencyDesktopBridge type out of this contract test.
  (window as unknown as { consistencyDesktop?: unknown }).consistencyDesktop = {};
}

afterEach(() => {
  delete (window as unknown as { consistencyDesktop?: unknown }).consistencyDesktop;
});

describe("DesktopSettingsSection structure", () => {
  it("renders the stable row ids and the section title", () => {
    const html = renderSection();
    expect(html).toContain("05 · Desktop");
    expect(html).toContain("Desktop app behavior");
    expect(html).toContain('id="setting-desktop-close"');
    expect(html).toContain('id="setting-desktop-tray"');
    expect(html).toContain('id="setting-desktop-autostart"');
    expect(html).toContain('id="setting-desktop-notifications"');
    expect(html).toContain('id="setting-desktop-browser-note"');
  });

  it("exposes zero interactive controls — read-only status, no fake toggles", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <DesktopSettingsSection />
        </I18nProvider>
      );
    });

    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("textarea")).toHaveLength(0);
    // The whole section is note rows only.
    expect(container.querySelectorAll(".setting-field")).toHaveLength(5);
    expect(container.querySelectorAll(".setting-field.setting-note")).toHaveLength(5);

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("DesktopSettingsSection truthful fixed behavior", () => {
  it("describes close-to-tray, the always-present tray, autostart off and no notifications", () => {
    const html = renderSection();
    expect(html).toContain("Close behavior");
    expect(html).toContain("Stays resident in the system tray when the window closes");
    expect(html).toContain("Quit completely through the tray menu.");
    expect(html).toContain("System tray");
    expect(html).toContain("Always present");
    expect(html).toContain("Start on login");
    expect(html).toContain("Not enabled");
    expect(html).toContain("Deliberately kept off under the current security model.");
    expect(html).toContain("Notifications");
    expect(html).toContain("Not available yet");
    expect(html).toContain("No desktop notification system exists yet, so no option is offered.");
  });

  it("shows the browser-mode note when no desktop bridge exists", () => {
    const html = renderSection();
    expect(html).toContain("Browser mode");
    expect(html).toContain("Browser mode: these rows describe the desktop app and only apply when running inside it.");
  });

  it("hides the browser-mode note but keeps the fixed rows when a desktop bridge exists", () => {
    installBridge();
    const html = renderSection();
    expect(html).not.toContain('id="setting-desktop-browser-note"');
    expect(html).toContain("Stays resident in the system tray when the window closes");
    expect(html).toContain("Always present");
    expect(html).toContain("Not enabled");
    expect(html).toContain("Not available yet");
  });
});

describe("DesktopSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection("zh-CN");
    expect(html).toContain("05 · 桌面端");
    expect(html).toContain("桌面端行为");
    expect(html).toContain("关闭窗口时驻留系统托盘");
    expect(html).toContain("如需完全退出，请通过托盘菜单操作。");
    expect(html).toContain("系统托盘");
    expect(html).toContain("常驻");
    expect(html).toContain("未启用");
    expect(html).toContain("通知");
    expect(html).toContain("暂未提供");
    expect(html).toContain("浏览器模式：以上条目描述桌面端应用的固定行为，仅在桌面端运行时生效。");
    expect(html).not.toContain("Close behavior");
    expect(html).not.toContain("Always present");
    expect(html).not.toContain("Not enabled");
    expect(html).not.toContain("Not available yet");
    expect(html).not.toContain("Browser mode:");
  });
});
