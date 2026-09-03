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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubConnectionTestResponse } from "@consistency/schema";
import { api, type HealthResponse, type SettingsSnapshot } from "../../api/client";
import { emptySecrets, keepSecrets, type ClearSecrets, type SecretDrafts } from "../../hooks/useSettingsForm";
import type { DesktopGitHubOAuthDevicePollResult, DesktopGitHubOAuthResult } from "../../desktop";
import { I18nProvider } from "../../i18n";
import { GitHubSettingsSection } from "./GitHubSettingsSection";

const originalDesktopDescriptor = Object.getOwnPropertyDescriptor(window, "consistencyDesktop");

type DesktopOAuthFixture = {
  start: () => Promise<DesktopGitHubOAuthResult>;
  pollDeviceFlow: (input: { flowId: string }) => Promise<DesktopGitHubOAuthDevicePollResult>;
  cancel: () => Promise<{ status: "cancelled" }>;
};

function installDesktopOAuth(oauth: DesktopOAuthFixture): void {
  Object.defineProperty(window, "consistencyDesktop", {
    configurable: true,
    value: { githubOAuth: oauth }
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  if (originalDesktopDescriptor) Object.defineProperty(window, "consistencyDesktop", originalDesktopDescriptor);
  else Reflect.deleteProperty(window, "consistencyDesktop");
});

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
        anthropicModel: "",
        anthropicApiKeyConfigured: false,
        llmApiKeyConfigured: false,
        llmModel: "",
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
  applyGitHubDesktopOauth?: (login: string) => Promise<void>;
}) {
  const {
    health,
    restartPending,
    secrets = emptySecrets,
    clearSecrets = keepSecrets,
    settings,
    applyGitHubDesktopOauth = async () => undefined
  } = options ?? {};
  return {
    draft: draftSettings,
    settings: settings ?? draftSettings,
    secrets,
    clearSecrets,
    updateGithub: () => undefined,
    updateSecret: () => undefined,
    updateClear: () => undefined,
    applyGitHubOauthToken: async () => undefined,
    applyGitHubDesktopOauth,
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
  applyGitHubDesktopOauth?: (login: string) => Promise<void>;
}): string {
  const { locale = "en-US", ...rest } = options ?? {};
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <GitHubSettingsSection {...sectionProps(rest)} />
    </I18nProvider>
  );
}

async function mountSection(options?: { health?: HealthResponse; restartPending?: boolean; secrets?: SecretDrafts; settings?: SettingsSnapshot; applyGitHubDesktopOauth?: (login: string) => Promise<void> }) {
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
    expect(armedButton).not.toContain(' disabled=""');
    expect(armedButton).toContain('aria-disabled="false"');
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
    expect(html).toContain("通过 github.com 一键登录。仅授予身份标识与更高的读取速率配额——不授予任何仓库权限。");
    expect(html).not.toContain("Not tested yet");
    expect(html).not.toContain("Test Connection");
    expect(html).not.toContain("Test this token");
    expect(html).not.toContain("Restart to apply saved changes");
  });
});

describe("GitHub OAuth sign-in card", () => {
  it("keeps the Web Device Flow compatibility action available without desktop capabilities", async () => {
    const { container } = await mountSection();
    expect(container.querySelector("#setting-github-oauth-setup")).toBeNull();
    expect(container.querySelector("#setting-github-oauth-start")).not.toBeNull();
    expect(container.textContent).toContain("Sign in with GitHub");
    expect(container.textContent).toContain("no repository permissions");
  });

  it("uses the desktop browser flow without exposing device code or client secret on the renderer", async () => {
    const start = vi.fn().mockResolvedValue({ status: "connected", login: "octocat" });
    const pollDeviceFlow = vi.fn();
    const cancel = vi.fn().mockResolvedValue({ status: "cancelled" });
    installDesktopOAuth({ start, pollDeviceFlow, cancel });
    const onDesktopConnected = vi.fn().mockResolvedValue(undefined);
    const { container, root } = await mountSection({ applyGitHubDesktopOauth: onDesktopConnected });
    expect(container.querySelector("#setting-oauthClientSecret")).toBeNull();
    expect(container.textContent).not.toContain("Enter this code on GitHub:");
    expect(container.textContent).not.toContain("Copy code");
    expect(container.textContent).not.toContain("github.com/login/device");

    await act(async () => { click(container, "setting-github-oauth-start"); });
    expect(start).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Signed in as octocat");
    expect(onDesktopConnected).toHaveBeenCalledWith("octocat");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("shows the desktop browser waiting state and cancellation without a token callback", async () => {
    let resolveStart!: (value: { status: "connected"; login: string }) => void;
    const start = vi.fn().mockReturnValue(new Promise(resolve => { resolveStart = resolve; }));
    const pollDeviceFlow = vi.fn();
    const cancel = vi.fn().mockResolvedValue({ status: "cancelled" });
    installDesktopOAuth({ start, pollDeviceFlow, cancel });
    const { container, root } = await mountSection();
    await act(async () => { click(container, "setting-github-oauth-start"); });
    expect(container.textContent).toContain("Complete authorization in your browser");
    expect(container.textContent).not.toContain("Enter this code on GitHub");

    const cancelButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Cancel"));
    await act(async () => { cancelButton?.click(); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Complete authorization in your browser");
    resolveStart({ status: "connected", login: "octocat" });

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("falls back to the main-proxied Device Flow when the desktop build ships no broker", async () => {
    const start = vi.fn().mockResolvedValue({
      status: "device-awaiting",
      flowId: "flow-fixture-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5
    });
    const pollDeviceFlow = vi.fn().mockResolvedValue({ status: "pending", retryAfterSeconds: 5 });
    const cancel = vi.fn().mockResolvedValue({ status: "cancelled" });
    installDesktopOAuth({ start, pollDeviceFlow, cancel });
    // The renderer itself must never touch the device-flow HTTP routes: the
    // desktop security boundary blocks them and main owns the token handoff.
    const startDevice = vi.spyOn(api, "startGitHubOauthDeviceFlow");
    const pollDevice = vi.spyOn(api, "pollGitHubOauthDeviceFlow");
    const { container, root } = await mountSection();

    await act(async () => { click(container, "setting-github-oauth-start"); });
    expect(start).toHaveBeenCalledOnce();
    expect(startDevice).not.toHaveBeenCalled();
    expect(pollDevice).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter this code on GitHub:");
    expect(container.textContent).toContain("ABCD-1234");
    expect(container.textContent).toContain("github.com/login/device");
    // The fallback never surfaces a client secret field.
    expect(container.querySelector("#setting-oauthClientSecret")).toBeNull();

    await act(async () => { root.unmount(); });
    startDevice.mockRestore();
    pollDevice.mockRestore();
    document.body.removeChild(container);
  });

  it("keeps the honest not-configured failure when neither broker nor Device Flow client id exists", async () => {
    const start = vi.fn().mockResolvedValue({ status: "not_configured" });
    const pollDeviceFlow = vi.fn();
    const cancel = vi.fn().mockResolvedValue({ status: "cancelled" });
    installDesktopOAuth({ start, pollDeviceFlow, cancel });
    const { container, root } = await mountSection();

    await act(async () => { click(container, "setting-github-oauth-start"); });
    expect(start).toHaveBeenCalledOnce();
    expect(pollDeviceFlow).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This ConsistenCy desktop build has no GitHub sign-in service configured.");
    expect(container.textContent).not.toContain("Enter this code on GitHub");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});
