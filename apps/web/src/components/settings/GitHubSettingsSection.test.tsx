/**
 * Shared GitHubSettingsSection contract tests for CKPT4 Slice 2.
 *
 * The section is the single GitHub presentation used by both the /settings
 * page and the Settings Dialog. These tests pin the stable status element
 * ids, the ACTIVE (health-derived) read-only summary rows, the explicit-only
 * Test Connection action (no auto-run, no polling), sanitized result states,
 * graceful degradation without health, and zh-CN coverage for every new
 * user-visible string. The api client seam is mocked; no network is touched.
 */
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubConnectionTestResponse } from "@consistency/schema";
import { api, type HealthResponse, type SettingsSnapshot } from "../../api/client";
import { emptySecrets, keepSecrets, type ClearSecrets, type SecretDrafts } from "../../hooks/useSettingsForm";
import { I18nProvider } from "../../i18n";
import { GitHubSettingsSection } from "./GitHubSettingsSection";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, testGitHubConnection: vi.fn() }
  };
});

const testConnectionMock = vi.mocked(api.testGitHubConnection);

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
    oauthClientId: "",
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

function makeHealth(): HealthResponse {
  return {
    ok: true,
    service: "consistency-api",
    database: { ok: true },
    worker: { running: true, activeJobs: 0, concurrency: 4 },
    llmProvider: "deepseek",
    llmModel: "deepseek-chat",
    publicPrAccessMode: "anonymous",
    configuration: {
      githubAppConfigured: false,
      webhookSecretConfigured: true,
      publicReadTokenConfigured: true,
      storage: { kind: "file", configured: true },
      workerConcurrency: 4
    }
  };
}

function sectionProps(options?: {
  health?: HealthResponse;
  restartPending?: boolean;
  secrets?: SecretDrafts;
  clearSecrets?: ClearSecrets;
  settings?: SettingsSnapshot;
}) {
  const { health, restartPending, secrets = emptySecrets, clearSecrets = keepSecrets, settings } = options ?? {};
  return {
    draft: draftSettings,
    settings: settings ?? draftSettings,
    secrets,
    clearSecrets,
    updateGithub: () => undefined,
    updateSecret: () => undefined,
    updateClear: () => undefined,
    applyGitHubOauthToken: async () => undefined,
    ...(health === undefined ? {} : { health }),
    ...(restartPending === undefined ? {} : { restartPending })
  };
}

function renderSection(options?: {
  health?: HealthResponse;
  restartPending?: boolean;
  locale?: "en-US" | "zh-CN";
  secrets?: SecretDrafts;
  settings?: SettingsSnapshot;
}): string {
  const { locale = "en-US", ...rest } = options ?? {};
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <GitHubSettingsSection {...sectionProps(rest)} />
    </I18nProvider>
  );
}

async function mountSection(options?: { health?: HealthResponse; restartPending?: boolean; secrets?: SecretDrafts; settings?: SettingsSnapshot }) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en-US">
        <GitHubSettingsSection {...sectionProps(options)} />
      </I18nProvider>
    );
  });
  return { container, root };
}

function click(container: HTMLElement, id: string) {
  container.querySelector<HTMLButtonElement>(`#${id}`)?.click();
}

const connectedResult: GitHubConnectionTestResponse = {
  status: "connected",
  mode: "pat",
  testedAt: "2026-08-24T00:00:00.000Z"
};

beforeEach(() => {
  testConnectionMock.mockReset();
});

describe("GitHubSettingsSection connection status rows", () => {
  it("renders the stable status row ids from ACTIVE health truth", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain('id="setting-github-status-access"');
    expect(html).toContain('id="setting-github-status-app"');
    expect(html).toContain('id="setting-github-status-webhook"');
    expect(html).toContain('id="setting-github-status-token"');
    expect(html).toContain("Anonymous read");
    expect(html).toContain("Not configured");
    expect(html).toContain("Configured");
  });

  it("labels the PAT access mode truthfully", () => {
    const health = { ...makeHealth(), publicPrAccessMode: "pat" as const };
    expect(renderSection({ health })).toContain("PAT read");
    const disabled = { ...makeHealth(), publicPrAccessMode: "disabled" as const };
    expect(renderSection({ health: disabled })).toContain("Disabled");
    // Legacy payloads without the field fail closed to "Disabled" as well.
    const legacy = { ...makeHealth(), publicPrAccessMode: undefined };
    expect(renderSection({ health: legacy })).toContain("Disabled");
  });

  it("hides the summary rows when health is absent but keeps the explicit test action", () => {
    const html = renderSection();
    expect(html).not.toContain("setting-github-status-access");
    expect(html).not.toContain("setting-github-status-app");
    expect(html).not.toContain("setting-github-status-webhook");
    expect(html).not.toContain("setting-github-status-token");
    expect(html).toContain('id="setting-github-test"');
    expect(html).toContain("Not tested yet");
  });

  it("keeps the existing mode guide and secret field behavior unchanged", () => {
    const html = renderSection({ health: makeHealth() });
    expect(html).toContain('class="source-mode-guide');
    expect(html).toContain('id="setting-app-id"');
    expect(html).toContain('id="setting-publicReadToken"');
    expect(html).toContain('id="setting-webhookSecret"');
    expect(html).toContain('id="setting-privateKey"');
  });
});

describe("GitHubSettingsSection Test Connection action", () => {
  it("never auto-runs the probe on mount", async () => {
    const { container, root } = await mountSection({ health: makeHealth() });
    expect(testConnectionMock).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain("Not tested yet");
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("runs exactly one probe per click and renders the sanitized connected result", async () => {
    testConnectionMock.mockResolvedValue(connectedResult);
    const { container, root } = await mountSection({ health: makeHealth() });

    await act(async () => { click(container, "setting-github-test"); });
    await act(async () => { click(container, "setting-github-test"); });

    expect(testConnectionMock).toHaveBeenCalledTimes(2);
    expect(testConnectionMock).toHaveBeenCalledWith();
    const result = container.querySelector("#setting-github-status-result");
    expect(result?.textContent).toContain("Connected");
    expect(result?.innerHTML).toContain("badge-succeeded");
    expect(result?.innerHTML).not.toContain("Not tested yet");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("renders rate_limited with bounded retry minutes", async () => {
    testConnectionMock.mockResolvedValue({
      status: "rate_limited",
      retryAfterMs: 90_000,
      testedAt: "2026-08-24T00:00:00.000Z"
    });
    const { container, root } = await mountSection({ health: makeHealth() });
    await act(async () => { click(container, "setting-github-test"); });
    const result = container.querySelector("#setting-github-status-result");
    expect(result?.textContent).toContain("Rate limited");
    expect(result?.textContent).toContain("Retry available in 2 min");
    expect(result?.innerHTML).toContain("badge-medium");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("renders a generic unavailable message when the probe call itself fails", async () => {
    testConnectionMock.mockRejectedValueOnce(new Error("API request failed ghp_test_fake"));
    const { container, root } = await mountSection({ health: makeHealth() });
    await act(async () => { click(container, "setting-github-test"); });
    const result = container.querySelector("#setting-github-status-result");
    expect(result?.textContent).toContain("Connection test unavailable");
    expect(container.innerHTML).not.toContain("ghp_test_fake");
    expect(container.innerHTML).not.toContain("API request failed");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("shows the restart hint only while a restart is pending", () => {
    const hint = "Tests use the running configuration. Restart to apply saved changes.";
    expect(renderSection({ restartPending: true })).toContain(hint);
    expect(renderSection({ restartPending: false })).not.toContain(hint);
    expect(renderSection()).not.toContain(hint);
  });
});

describe("GitHubSettingsSection unsaved draft token probe", () => {
  it("keeps the draft-token probe disabled until a non-empty token draft exists", () => {
    const idleHtml = renderSection({ health: makeHealth() });
    const idleButton = idleHtml.match(/<button[^>]*id="setting-github-test-draft"[^>]*>/)?.[0] ?? "";
    expect(idleButton).toContain("disabled");

    const armedHtml = renderSection({
      health: makeHealth(),
      secrets: { ...emptySecrets, publicReadToken: "ghp_draft_fake" }
    });
    const armedButton = armedHtml.match(/<button[^>]*id="setting-github-test-draft"[^>]*>/)?.[0] ?? "";
    expect(armedButton).not.toContain("disabled");
  });

  it("probes exactly one unsaved draft per click through the schema body and renders the sanitized result", async () => {
    testConnectionMock.mockResolvedValue(connectedResult);
    const { container, root } = await mountSection({
      health: makeHealth(),
      secrets: { ...emptySecrets, publicReadToken: "ghp_draft_fake" }
    });

    await act(async () => { click(container, "setting-github-test-draft"); });
    await act(async () => { click(container, "setting-github-test-draft"); });

    expect(testConnectionMock).toHaveBeenCalledTimes(2);
    expect(testConnectionMock).toHaveBeenCalledWith(undefined, { publicReadToken: "ghp_draft_fake" });
    const result = container.querySelector("#setting-github-draft-result");
    expect(result?.textContent).toContain("Connected");
    // The typed draft lives only in its own password input; the probe output
    // must never echo the token back.
    expect(result?.innerHTML).not.toContain("ghp_draft_fake");
    const statusSection = container.innerHTML.slice(container.innerHTML.indexOf('aria-label="Connection status"'));
    expect(statusSection).not.toContain("ghp_draft_fake");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("maps a failed draft probe to the generic unavailable message without echoing the token", async () => {
    testConnectionMock.mockRejectedValueOnce(new Error("API request failed ghp_draft_fake"));
    const { container, root } = await mountSection({
      health: makeHealth(),
      secrets: { ...emptySecrets, publicReadToken: "ghp_draft_fake" }
    });

    await act(async () => { click(container, "setting-github-test-draft"); });
    const result = container.querySelector("#setting-github-draft-result");
    expect(result?.textContent).toContain("Connection test unavailable");
    expect(result?.innerHTML).not.toContain("ghp_draft_fake");
    expect(container.innerHTML).not.toContain("API request failed");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});

describe("GitHubSettingsSection security surface", () => {
  it("renders no secret values and no filesystem paths in the connection status output", () => {
    const html = renderSection({
      health: makeHealth(),
      secrets: { ...emptySecrets, publicReadToken: "ghp_test_fake", webhookSecret: "whsec_test_fake" }
    });
    // Secret drafts live only in their own editable password fields; the
    // read-only connection status section must never echo them.
    const statusSection = html.slice(html.indexOf('aria-label="Connection status"'));
    expect(statusSection).not.toContain("ghp_test_fake");
    expect(statusSection).not.toContain("whsec_test_fake");
    expect(statusSection).not.toMatch(/type="password"/);
    expect(statusSection).not.toMatch(/[A-Za-z]:\\/);
    expect(statusSection).not.toMatch(/\/(?:home|Users|root|var|tmp)\//);
  });
});

describe("GitHubSettingsSection zh-CN coverage", () => {
  it("translates every newly introduced user-visible string without English fallback", () => {
    const html = renderSection({ health: makeHealth(), restartPending: true, locale: "zh-CN" });
    expect(html).toContain("连接状态");
    expect(html).toContain("匿名读取");
    expect(html).toContain("尚未测试");
    expect(html).toContain("测试连接");
    expect(html).toContain("试连此令牌");
    expect(html).toContain("仅对这条未保存的令牌发起一次只读请求；不会存储或回显该令牌。");
    expect(html).toContain("测试针对当前运行中的配置；重启后才会应用已保存的更改。");
    expect(html).toContain("GitHub 登录（OAuth）");
    expect(html).toContain("在下方配置 OAuth App 的 Client ID 并重启，即可启用一键 GitHub 登录——无需个人令牌。");
    expect(html).not.toContain("Not tested yet");
    expect(html).not.toContain("Test Connection");
    expect(html).not.toContain("Test this token");
    expect(html).not.toContain("Restart to apply saved changes");
  });
});

describe("GitHub OAuth sign-in card", () => {
  it("renders an honest setup hint while no OAuth client id is configured", async () => {
    const { container } = await mountSection();
    expect(container.querySelector("#setting-github-oauth-setup")).not.toBeNull();
    expect(container.querySelector("#setting-github-oauth-start")).toBeNull();
  });

  it("offers device-flow sign-in once an OAuth client id is configured", async () => {
    const configured: SettingsSnapshot = {
      ...draftSettings,
      github: { ...draftSettings.github, oauthClientId: "Iv1_client123" }
    };
    const { container } = await mountSection({ settings: configured });
    const start = container.querySelector<HTMLButtonElement>("#setting-github-oauth-start");
    expect(start).not.toBeNull();
    expect(start?.textContent).toContain("Sign in with GitHub");
    expect(container.textContent).toContain("no repository permissions");
  });
});
