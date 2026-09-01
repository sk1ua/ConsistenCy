/**
 * Shared RuntimeSettingsSection contract tests for CKPT4 Slice 1.
 *
 * The section is the single runtime presentation used by both the /settings
 * page and the Settings Dialog. These tests pin the stable element ids, the
 * read-only (no secret, no raw path) status rows, the desired-vs-active
 * worker concurrency drift notice, graceful degradation without health, and
 * zh-CN coverage for every new user-visible string.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { HealthResponse, SettingsSnapshot } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { RuntimeSettingsSection } from "./RuntimeSettingsSection";

const draftSettings: SettingsSnapshot = {
  llm: {
    provider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-chat",
    openaiModel: "",
    deepseekApiKeyConfigured: true,
    openaiApiKeyConfigured: false
  },
  github: {
    appId: "123456",
    privateKeyConfigured: true,
    webhookSecretConfigured: true,
    publicReadTokenConfigured: true
  },
  runtime: {
    storage: { kind: "file", configured: true },
    workspace: { configured: true },
    localReview: { configured: true, rootCount: 2 },
    workerConcurrency: 4,
    workerPollIntervalMs: 750,
    webUrl: "http://127.0.0.1:5173",
    apiTokenConfigured: false
  },
  overriddenByEnvironment: [],
  restartRequired: false
};

function makeHealth(workerConcurrency: number): HealthResponse {
  return {
    ok: true,
    service: "consistency-api",
    database: { ok: true },
    worker: { running: true, activeJobs: 3, concurrency: workerConcurrency },
    llmProvider: "deepseek",
    llmModel: "deepseek-chat",
    publicPrAccessMode: "anonymous",
    configuration: {
      githubAppConfigured: true,
      webhookSecretConfigured: true,
      publicReadTokenConfigured: true,
      storage: { kind: "file", configured: true },
      workerConcurrency
    }
  };
}

function renderSection(options?: { draft?: SettingsSnapshot; settings?: SettingsSnapshot; health?: HealthResponse; locale?: "en-US" | "zh-CN" }): string {
  const { draft = draftSettings, settings = draftSettings, health, locale = "en-US" } = options ?? {};
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <RuntimeSettingsSection
        draft={draft}
        settings={settings}
        health={health}
        updateRuntime={() => undefined}
      />
    </I18nProvider>
  );
}

// Mounts the section the way the real settings page does: `settings` is the
// saved snapshot, `draft` is a local copy the user can edit without saving.
async function mountDriftSection(saved: SettingsSnapshot, health?: HealthResponse) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  function DriftHost() {
    const [draft, setDraft] = useState<SettingsSnapshot>(saved);
    return (
      <I18nProvider initialLocale="en-US">
        <RuntimeSettingsSection
          draft={draft}
          settings={saved}
          health={health}
          updateRuntime={patch => setDraft(previous => ({ ...previous, runtime: { ...previous.runtime, ...patch } }))}
        />
      </I18nProvider>
    );
  }
  await act(async () => { root.render(<DriftHost />); });
  return { container, root };
}

function typeIntoValue(container: HTMLElement, id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  // Bypass React's instance-level value tracker so the native input event
  // is observed as a real controlled change (same approach the reopen
  // lifecycle test relies on, made explicit here).
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("RuntimeSettingsSection editable fields", () => {
  it("renders the stable editable field ids bound to the draft runtime values", () => {
    const html = renderSection({ health: makeHealth(4) });
    expect(html).toContain('id="setting-concurrency"');
    expect(html).toContain('id="setting-poll"');
    expect(html).toContain('id="setting-web-url"');
    expect(html).toMatch(/<input[^>]*id="setting-concurrency"[^>]*type="number"[^>]*min="1"[^>]*max="16"[^>]*value="4"/);
    expect(html).toMatch(/<input[^>]*id="setting-poll"[^>]*type="number"[^>]*min="50"[^>]*max="60000"[^>]*value="750"/);
    expect(html).toMatch(/<input[^>]*id="setting-web-url"[^>]*type="url"[^>]*value="http:\/\/127\.0\.0\.1:5173"/);
  });

  it("coerces numeric edits through Number() and passes web URL edits through verbatim", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const updateRuntime = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en-US">
          <RuntimeSettingsSection draft={draftSettings} settings={draftSettings} updateRuntime={updateRuntime} />
        </I18nProvider>
      );
    });

    function typeInto(id: string, value: string) {
      const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
      // Bypass React's instance-level value tracker so the native input event
      // is observed as a real controlled change (same approach the reopen
      // lifecycle test relies on, made explicit here).
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    await act(async () => { typeInto("setting-concurrency", "8"); });
    expect(updateRuntime).toHaveBeenLastCalledWith({ workerConcurrency: 8 });

    await act(async () => { typeInto("setting-poll", "1200"); });
    expect(updateRuntime).toHaveBeenLastCalledWith({ workerPollIntervalMs: 1200 });

    await act(async () => { typeInto("setting-web-url", "http://localhost:4173"); });
    expect(updateRuntime).toHaveBeenLastCalledWith({ webUrl: "http://localhost:4173" });

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("RuntimeSettingsSection read-only status rows", () => {
  it("renders sanitized status rows only (booleans and kinds, never paths or tokens)", () => {
    const html = renderSection({ health: makeHealth(4) });
    expect(html).toContain("Local file storage configured");
    expect(html).toContain("Review workspace configured");
    expect(html).toContain("Local review roots configured: 2");
    expect(html).toContain("Browser development session is not protected");
    expect(html).toContain("npm run config -- set runtime.api-token");
  });

  it("renders the not-configured variants for storage, workspace and review roots", () => {
    const bare: SettingsSnapshot = {
      ...draftSettings,
      runtime: {
        ...draftSettings.runtime,
        storage: { kind: "memory", configured: false },
        workspace: { configured: false },
        localReview: { configured: false, rootCount: 0 }
      }
    };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en-US">
        <RuntimeSettingsSection draft={bare} settings={bare} updateRuntime={() => undefined} />
      </I18nProvider>
    );
    expect(html).toContain("In-memory storage configured");
    expect(html).toContain("Review workspace not configured");
    expect(html).toContain("No local review roots configured");
  });

  it("exposes no secret input and no filesystem path value anywhere in the section", () => {
    const html = renderSection({ health: makeHealth(4) });
    expect(html).not.toMatch(/type="password"/);
    expect(html).not.toMatch(/token=[A-Za-z0-9]/i);
    // No drive-letter or absolute home-directory path leaks from the snapshot.
    expect(html).not.toMatch(/[A-Za-z]:\\/);
    expect(html).not.toMatch(/\/(?:home|Users|root|var|tmp)\//);
    // The only inputs are the three editable fields.
    const inputIds = [...html.matchAll(/<input[^>]*id="(setting-[^"]+)"/g)].map(match => match[1]);
    expect(inputIds).toEqual(["setting-concurrency", "setting-poll", "setting-web-url"]);
  });
});

describe("RuntimeSettingsSection desired-vs-active truth", () => {
  it("shows active worker and storage rows derived from health", () => {
    const html = renderSection({ health: makeHealth(4) });
    expect(html).toContain("Active runtime");
    expect(html).toContain("Running · concurrency 4 · 3 active jobs");
    expect(html).toContain("Local file storage");
  });

  it("shows the restart notice only when saved and active concurrency differ", () => {
    const drifted = renderSection({ health: makeHealth(1) });
    expect(drifted).toContain("Saved 4 · Active 1 — restart required");

    // Saved and active agree while the draft holds an unsaved edit: the drift
    // notice reads the saved snapshot, so it must stay hidden — unsaved edits
    // do not imply a restart.
    const unsavedDraft: SettingsSnapshot = { ...draftSettings, runtime: { ...draftSettings.runtime, workerConcurrency: 8 } };
    const aligned = renderSection({ draft: unsavedDraft, health: makeHealth(4) });
    expect(aligned).not.toContain("restart required");
    expect(aligned).not.toContain("Saved 4");
  });

  it("does not show the notice when saved equals active and the user edits the draft without saving", async () => {
    const { container, root } = await mountDriftSection(draftSettings, makeHealth(4));
    expect(container.innerHTML).not.toContain("restart required");

    await act(async () => { typeIntoValue(container, "setting-concurrency", "8"); });
    expect(container.querySelector<HTMLInputElement>("#setting-concurrency")?.value).toBe("8");
    expect(container.innerHTML).not.toContain("restart required");
    expect(container.innerHTML).not.toContain("Saved 4");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("keeps the notice on real drift when the draft is edited back to the active value", async () => {
    const { container, root } = await mountDriftSection(draftSettings, makeHealth(1));
    expect(container.innerHTML).toContain("Saved 4 · Active 1 — restart required");

    await act(async () => { typeIntoValue(container, "setting-concurrency", "1"); });
    expect(container.querySelector<HTMLInputElement>("#setting-concurrency")?.value).toBe("1");
    expect(container.innerHTML).toContain("Saved 4 · Active 1 — restart required");
    expect(container.innerHTML).not.toContain("Saved 1");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("degrades gracefully when health is absent", () => {
    const html = renderSection();
    expect(html).toContain('id="setting-concurrency"');
    expect(html).not.toContain("Active runtime");
    expect(html).not.toContain("restart required");
  });
});

describe("RuntimeSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection({ health: makeHealth(1), locale: "zh-CN" });
    expect(html).toContain("本地审查根目录");
    expect(html).toContain("已配置本地审查根目录：2");
    expect(html).toContain("运行中 · 并发数 1 · 3 项活跃任务");
    expect(html).toContain("已保存 4 · 当前生效 1 — 需重启后生效");
    expect(html).toContain("本地审查根目录通过受保护的桌面目录选择器选择；原始路径不会传入 Web UI 状态。");
    expect(html).not.toContain("restart required");
    expect(html).not.toContain("active jobs");
    expect(html).not.toContain("Local review roots configured");
  });

  it("translates the not-configured review roots variant", () => {
    const bare: SettingsSnapshot = {
      ...draftSettings,
      runtime: { ...draftSettings.runtime, localReview: { configured: false, rootCount: 0 } }
    };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <RuntimeSettingsSection draft={bare} settings={bare} updateRuntime={() => undefined} />
      </I18nProvider>
    );
    expect(html).toContain("未配置本地审查根目录");
    expect(html).not.toContain("No local review roots configured");
  });
});
