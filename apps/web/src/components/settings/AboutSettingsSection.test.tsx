/**
 * Shared AboutSettingsSection contract tests for CKPT4 Slices 4 and 6.
 *
 * Every row must be grounded in an existing capability: build identity from
 * the desktop buildInfo bridge (short SHA with the full SHA only in a title
 * attribute), service / engine / schema version straight from the /health
 * payload, and the runtime mode derived from desktop bridge presence. These
 * tests pin the stable ids, the browser degradation (no bridge → explicit
 * not-available notes while health rows stay visible), health-absent hiding,
 * the desktop-shell mode variant, the no-filesystem-paths guarantee, and
 * zh-CN coverage.
 *
 * Slice 6 adds the semantic "Open logs folder" action: exactly one button in
 * desktop mode (only when the bridge exposes the zero-argument boolean-only
 * openLogsFolder method), none in the browser, generic success/failure lines,
 * and no path value anywhere in either variant.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HealthResponse } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { AboutSettingsSection } from "./AboutSettingsSection";

const health: HealthResponse = {
  ok: true,
  service: "consistency-api",
  engine: "python",
  schemaVersion: "0.1.0",
  database: { ok: true },
  worker: { running: true, activeJobs: 0, concurrency: 1 },
  llmProvider: "none",
  configuration: {
    githubAppConfigured: false,
    webhookSecretConfigured: false,
    publicReadTokenConfigured: false,
    storage: { kind: "memory", configured: false },
    workerConcurrency: 1
  }
};

const buildInfo = { version: "3.0.0", commitSha: "abcd1234ef567890abcd1234ef567890" };

function renderSection(props: { health?: HealthResponse; buildInfo?: { version: string; commitSha: string } | null }, locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AboutSettingsSection {...props} />
    </I18nProvider>
  );
}

function installBridge() {
  // The section only checks bridge presence (it calls no bridge method), so a
  // presence-only stub stands in for the preload surface; the unknown cast
  // keeps the global ConsistencyDesktopBridge type out of this contract test.
  (window as unknown as { consistencyDesktop?: unknown }).consistencyDesktop = {};
}

function installLogsBridge(openLogsFolder: () => Promise<{ ok: boolean }>) {
  (window as unknown as { consistencyDesktop?: unknown }).consistencyDesktop = { openLogsFolder };
}

// Mounts the section the way the settings hosts do, for exercising the one
// interactive control (the open-logs action) through real click events.
async function mountAbout(
  props: { health?: HealthResponse; buildInfo?: { version: string; commitSha: string } | null },
  locale: "en-US" | "zh-CN" = "en-US"
) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <AboutSettingsSection {...props} />
      </I18nProvider>
    );
  });
  return { container, root };
}

afterEach(() => {
  delete (window as unknown as { consistencyDesktop?: unknown }).consistencyDesktop;
});

describe("AboutSettingsSection structure", () => {
  it("renders the stable row ids and the section title", () => {
    const html = renderSection({ health, buildInfo });
    expect(html).toContain("06 · About");
    expect(html).toContain("Version and environment");
    expect(html).toContain('id="setting-about-version"');
    expect(html).toContain('id="setting-about-build"');
    expect(html).toContain('id="setting-about-service"');
    expect(html).toContain('id="setting-about-engine"');
    expect(html).toContain('id="setting-about-schema"');
    expect(html).toContain('id="setting-about-mode"');
  });
});

describe("AboutSettingsSection grounded values", () => {
  it("shows the buildInfo version, the short SHA with the full SHA in a title attribute, and the health fields", () => {
    const html = renderSection({ health, buildInfo });
    expect(html).toContain("ConsistenCy version");
    expect(html).toContain("<code>3.0.0</code>");
    expect(html).toContain("Build");
    expect(html).toContain(">abcd123</code>");
    expect(html).toContain('title="Commit abcd1234ef567890abcd1234ef567890"');
    expect(html).toContain("API service");
    expect(html).toContain("<code>consistency-api</code>");
    expect(html).toContain("Engine");
    expect(html).toContain("<code>python</code>");
    expect(html).toContain("Schema version");
    expect(html).toContain("<code>0.1.0</code>");
  });

  it("derives the runtime mode from desktop bridge presence", () => {
    expect(renderSection({ health, buildInfo })).toContain("Browser");
    installBridge();
    const html = renderSection({ health, buildInfo });
    expect(html).toContain("Runtime mode");
    expect(html).toContain("Desktop");
    expect(html).not.toContain("Browser");
  });

  it("degrades truthfully in browser mode: build rows note desktop-only while health rows stay visible", () => {
    const html = renderSection({ health, buildInfo: null });
    expect(html).toContain("ConsistenCy version");
    expect(html).toContain("Provided by the desktop build only.");
    // The not-available note appears for both build rows and for the
    // desktop-only open-logs action row (Slice 6): three occurrences.
    expect(html.match(/Provided by the desktop build only\./g)?.length).toBe(3);
    expect(html).not.toContain("<code>3.0.0</code>");
    expect(html).toContain("<code>consistency-api</code>");
    expect(html).toContain("<code>python</code>");
    expect(html).toContain("<code>0.1.0</code>");
  });

  it("shows a neutral loading note on the build rows while the desktop buildInfo resolve is pending", () => {
    installBridge();
    const html = renderSection({ health, buildInfo: null });
    // Both build rows await the async bridge resolve with the loading note…
    expect(html.match(/Reading build information…/g)?.length).toBe(2);
    // …and neither claims the browser-mode desktop-only degradation; only the
    // logs row (bridge lacks the semantic method) still shows that note.
    expect(html.match(/Provided by the desktop build only\./g)?.length).toBe(1);

    const zhHtml = renderSection({ health, buildInfo: null }, "zh-CN");
    expect(zhHtml).toContain("正在读取构建信息…");
    expect(zhHtml).not.toContain("Reading build information…");
  });

  it("hides the health-derived rows when no health payload is available", () => {
    const html = renderSection({ buildInfo });
    expect(html).not.toContain('id="setting-about-service"');
    expect(html).not.toContain('id="setting-about-engine"');
    expect(html).not.toContain('id="setting-about-schema"');
    expect(html).toContain('id="setting-about-version"');
    expect(html).toContain("<code>3.0.0</code>");
  });

  it("never surfaces filesystem paths or secret-shaped values", () => {
    const html = renderSection({ health, buildInfo });
    expect(html).not.toContain("userData");
    expect(html).not.toContain("AppData");
    expect(html).not.toContain("/home/");
    expect(html).not.toContain("/Users/");
    expect(html).not.toMatch(/[A-Za-z]:\\/);
    // The full SHA appears only inside the title attribute, never as row text.
    expect(html.match(/abcd1234ef567890abcd1234ef567890/g)?.length).toBe(1);
    expect(html).toContain('title="Commit abcd1234ef567890abcd1234ef567890"');
  });
});

describe("AboutSettingsSection open-logs action (Slice 6)", () => {
  it("renders no button in browser mode and degrades to the desktop-only note", () => {
    const html = renderSection({ health, buildInfo });
    expect(html).toContain('id="setting-about-logs-row"');
    expect(html).not.toContain('id="setting-about-open-logs"');
    expect(html).not.toContain("<button");
    expect(html).toContain("Provided by the desktop build only.");
  });

  it("renders no button when a bridge exists but lacks the semantic method", () => {
    installBridge();
    const html = renderSection({ health, buildInfo });
    expect(html).not.toContain('id="setting-about-open-logs"');
    expect(html).not.toContain("<button");
  });

  it("renders exactly one button when the bridge exposes openLogsFolder", () => {
    installLogsBridge(async () => ({ ok: true }));
    const html = renderSection({ health, buildInfo });
    expect(html).toContain('id="setting-about-open-logs"');
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).toContain("Open logs folder");
    expect(html).toContain('role="status"');
  });

  it("keeps every path-shaped value out of the desktop action row", () => {
    installLogsBridge(async () => ({ ok: true }));
    const html = renderSection({ health, buildInfo });
    expect(html).not.toContain("userData");
    expect(html).not.toContain("AppData");
    expect(html).not.toContain("/home/");
    expect(html).not.toContain("/Users/");
    expect(html).not.toMatch(/[A-Za-z]:\\/);
  });

  it("clicking the button calls the bridge with no arguments and reports generic success", async () => {
    const openLogsFolder = vi.fn(async () => ({ ok: true }));
    installLogsBridge(openLogsFolder);
    const { container, root } = await mountAbout({ health, buildInfo });
    expect(container.innerHTML).toContain("The main and API logs are written");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#setting-about-open-logs")!.click();
    });
    // Semantic action contract: exactly one invocation, zero arguments — the
    // renderer never passes (or owns) a path.
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
    expect(openLogsFolder.mock.calls[0]).toEqual([]);
    expect(container.innerHTML).toContain("Logs folder opened.");
    expect(container.innerHTML).not.toContain("Could not open");
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("reports only the generic failure line when the action fails or rejects", async () => {
    const openLogsFolder = vi.fn(async () => ({ ok: false }));
    installLogsBridge(openLogsFolder);
    const first = await mountAbout({ health, buildInfo });
    await act(async () => {
      first.container.querySelector<HTMLButtonElement>("#setting-about-open-logs")!.click();
    });
    expect(first.container.innerHTML).toContain("Could not open the logs folder.");
    expect(first.container.innerHTML).not.toContain("Logs folder opened.");
    await act(async () => { first.root.unmount(); });
    document.body.removeChild(first.container);

    const rejecting = vi.fn(async () => {
      throw new Error("C:\\Users\\owner\\AppData\\Roaming\\ConsistenCy");
    });
    installLogsBridge(rejecting);
    const second = await mountAbout({ health, buildInfo });
    await act(async () => {
      second.container.querySelector<HTMLButtonElement>("#setting-about-open-logs")!.click();
    });
    expect(second.container.innerHTML).toContain("Could not open the logs folder.");
    // The rejection's message (which carries a path) never reaches the DOM.
    expect(second.container.innerHTML).not.toContain("AppData");
    expect(second.container.innerHTML).not.toMatch(/[A-Za-z]:\\/);
    await act(async () => { second.root.unmount(); });
    document.body.removeChild(second.container);
  });
});

describe("AboutSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection({ health, buildInfo }, "zh-CN");
    expect(html).toContain("06 · 关于");
    expect(html).toContain("版本与环境");
    expect(html).toContain("ConsistenCy 版本");
    expect(html).toContain("构建标识");
    expect(html).toContain("API 服务");
    expect(html).toContain("引擎");
    expect(html).toContain("协议版本");
    expect(html).toContain("运行环境");
    expect(html).toContain("浏览器");
    expect(html).not.toContain("Version and environment");
    expect(html).not.toContain("ConsistenCy version");
    expect(html).not.toContain("Schema version");
    expect(html).not.toContain("Browser");
  });

  it("keeps the browser not-available note translated", () => {
    const html = renderSection({ health, buildInfo: null }, "zh-CN");
    expect(html).toContain("仅桌面端提供。");
    expect(html).not.toContain("Provided by the desktop build only.");
  });
});

describe("AboutSettingsSection open-logs zh-CN coverage", () => {
  it("translates the action row without English fallback and without path values", () => {
    installLogsBridge(async () => ({ ok: true }));
    const html = renderSection({ health, buildInfo }, "zh-CN");
    expect(html).toContain("日志");
    expect(html).toContain("打开日志文件夹");
    expect(html).toContain("主进程与 API 日志写入桌面端应用自身的数据文件夹。");
    expect(html).toContain("在文件管理器中打开桌面端应用自身的数据文件夹");
    expect(html).not.toContain("Open logs folder");
    expect(html).not.toContain("The main and API logs are written");
    expect(html).not.toMatch(/[A-Za-z]:\\/);
  });
});
