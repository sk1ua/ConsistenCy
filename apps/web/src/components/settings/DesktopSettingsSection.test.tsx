/**
 * Shared DesktopSettingsSection contract tests.
 *
 * Close behavior, tray visibility and login launch are REAL toggles: each
 * change is applied immediately through the desktop preferences bridge and
 * persisted by the Electron main process. These tests pin the stable element
 * ids, the switch semantics (disabled without a preferences bridge, enabled
 * after it reports state, revert on rejection), the notifications row staying
 * an honest informational status (no fake toggle), the truthful browser-mode
 * degradation, and zh-CN coverage for every user-visible string.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { DesktopSettingsSection } from "./DesktopSettingsSection";
import type { DesktopPreferences, DesktopPreferencesPatch } from "../../desktop";

// The default test environment exposes no window.consistencyDesktop, so the
// section renders its browser-mode degradation by default.
function renderSection(locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <DesktopSettingsSection />
    </I18nProvider>
  );
}

type PreferencesBridgeStub = {
  get: () => Promise<DesktopPreferences>;
  set: (patch: DesktopPreferencesPatch) => Promise<DesktopPreferences>;
};

const DEFAULTS: DesktopPreferences = { closeToTray: true, trayEnabled: true, launchAtLogin: false };

function installBridge(options: { get?: () => Promise<DesktopPreferences>; set?: (patch: DesktopPreferencesPatch) => Promise<DesktopPreferences> } = {}) {
  const setCalls: DesktopPreferencesPatch[] = [];
  const bridge: PreferencesBridgeStub = {
    get: options.get ?? (async () => ({ ...DEFAULTS })),
    set: options.set ?? (async patch => {
      setCalls.push(patch);
      return { ...DEFAULTS, ...patch };
    })
  };
  (window as unknown as { consistencyDesktop?: unknown }).consistencyDesktop = { preferences: bridge };
  return { setCalls };
}

async function mountSection(): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
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
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      document.body.removeChild(container);
    }
  };
}

function switches(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
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

  it("renders disabled switches in browser mode and keeps notifications as an honest status row", async () => {
    const { container, unmount } = await mountSection();
    // Three real switches (close, tray, login) but no switch for notifications.
    expect(switches(container)).toHaveLength(3);
    for (const element of switches(container)) {
      expect(element.disabled).toBe(true);
    }
    expect(container.querySelector("#setting-desktop-notifications [role=\"switch\"]")).toBeNull();
    expect(container.querySelector("#setting-desktop-notifications")).toBeTruthy();
    expect(container.querySelectorAll(".setting-field")).toHaveLength(5);
    await unmount();
  });
});

describe("DesktopSettingsSection real toggles", () => {
  it("enables the switches and reports defaults once the bridge answers", async () => {
    installBridge();
    const { container, unmount } = await mountSection();
    for (const element of switches(container)) {
      expect(element.disabled).toBe(false);
    }
    expect(container.querySelector<HTMLButtonElement>("#setting-desktop-close-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>("#setting-desktop-tray-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>("#setting-desktop-autostart-switch")?.getAttribute("aria-checked")).toBe("false");
    await unmount();
  });

  it("applies a toggle immediately through the preferences bridge", async () => {
    const { setCalls } = installBridge();
    const { container, unmount } = await mountSection();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#setting-desktop-autostart-switch")?.click();
      await Promise.resolve();
    });
    expect(setCalls).toEqual([{ launchAtLogin: true }]);
    expect(container.querySelector<HTMLButtonElement>("#setting-desktop-autostart-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("#setting-desktop-autostart-error")).toBeNull();
    await unmount();
  });

  it("reverts the optimistic state and surfaces an error when the host rejects the patch", async () => {
    installBridge({ set: async () => { throw new Error("rejected"); } });
    const { container, unmount } = await mountSection();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#setting-desktop-tray-switch")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLButtonElement>("#setting-desktop-tray-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("#setting-desktop-trayEnabled-error")).toBeTruthy();
    await unmount();
  });

  it("keeps the switches disabled when the host never reports preferences", async () => {
    installBridge({ get: async () => { throw new Error("unavailable"); } });
    const { container, unmount } = await mountSection();
    for (const element of switches(container)) {
      expect(element.disabled).toBe(true);
    }
    expect(container.querySelector("#setting-desktop-load-error")).toBeTruthy();
    await unmount();
  });
});

describe("DesktopSettingsSection truthful presentation", () => {
  it("describes the toggle rows and the honest notifications row", () => {
    const html = renderSection();
    expect(html).toContain("Close behavior");
    expect(html).toContain("System tray");
    expect(html).toContain("Start on login");
    expect(html).toContain("Notifications");
    expect(html).toContain("Not available yet");
    expect(html).toContain("No desktop notification system exists yet, so no option is offered.");
  });

  it("shows the browser-mode note when no desktop bridge exists", () => {
    const html = renderSection();
    expect(html).toContain("Browser mode");
    expect(html).toContain("Browser mode: these rows describe the desktop app and only apply when running inside it.");
  });

  it("hides the browser-mode note but keeps the rows when a desktop bridge exists", () => {
    installBridge();
    const html = renderSection();
    expect(html).not.toContain('id="setting-desktop-browser-note"');
    expect(html).toContain("Close behavior");
    expect(html).toContain("Not available yet");
  });
});

describe("DesktopSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection("zh-CN");
    expect(html).toContain("05 · 桌面端");
    expect(html).toContain("桌面端行为");
    // Default state: close-to-tray on, tray on, login launch off.
    expect(html).toContain("关闭窗口时驻留系统托盘");
    expect(html).toContain("托盘图标及“打开/退出”菜单可用");
    expect(html).toContain("未向操作系统注册登录启动");
    expect(html).toContain("关闭行为");
    expect(html).toContain("系统托盘");
    expect(html).toContain("开机自启");
    expect(html).toContain("通知");
    expect(html).toContain("暂未提供");
    expect(html).toContain("浏览器模式：以上条目描述桌面端应用的固定行为，仅在桌面端运行时生效。");
    expect(html).not.toContain("Close behavior");
    expect(html).not.toContain("Browser mode:");
    expect(html).not.toContain("Not available yet");
  });
});
