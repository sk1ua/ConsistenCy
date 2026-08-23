import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell, isCommandPaletteShortcut } from "./AppShell";

function renderShell(path = "/runs", overrides = {}): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/runs/:runId/*" element={
          <AppShell
            path={path}
            routeHref={path}
            meta={{ title: "Audit runs", shortTitle: "Runs", description: "Review runs", section: "Reviews" }}
            locale="en-US"
            setLocale={() => undefined}
            themePreference="dark"
            themeLabel="Dark"
            setThemePreference={() => undefined}
            cycleTheme={() => undefined}
            jobs={[]}
            repositories={[]}
            pulse={null}
            healthUnavailable={false}
            notices={[]}
            refreshing={false}
            onRefresh={() => undefined}
            {...overrides}
          >
            <p>Route content</p>
          </AppShell>
        } />
        <Route path="*" element={
          <AppShell
            path={path}
            routeHref={path}
            meta={{ title: "Audit runs", shortTitle: "Runs", description: "Review runs", section: "Reviews" }}
            locale="en-US"
            setLocale={() => undefined}
            themePreference="dark"
            themeLabel="Dark"
            setThemePreference={() => undefined}
            cycleTheme={() => undefined}
            jobs={[]}
            repositories={[]}
            pulse={null}
            healthUnavailable={false}
            notices={[]}
            refreshing={false}
            onRefresh={() => undefined}
            {...overrides}
          >
            <p>Route content</p>
          </AppShell>
        } />
      </Routes>
    </MemoryRouter>
  );
}

describe("Repository-Centric AppShell", () => {
  it("renders a single repository-first left sidebar without duplicate activity rail", () => {
    const html = renderShell("/repositories", {
      repositories: [
        {
          id: "repo_1",
          displayName: "ConsistenCy",
          source: "local_git",
          defaultBranch: "v3",
          trustLevel: "trusted_local",
          monitoringEnabled: true,
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z"
        }
      ]
    });

    // Contains the single repository-first sidebar
    expect(html).toContain("repo-first-sidebar");
    expect(html).toContain("ConsistenCy");

    // Does NOT contain obsolete chrome
    expect(html).not.toContain("activity-rail");
    expect(html).not.toContain("workbench-tabs");
    expect(html).not.toContain("run-ledger-toggle");
  });

  it("localizes the pull-requests breadcrumb per locale", () => {
    const repositories = [
      {
        id: "repo_1",
        displayName: "ConsistenCy",
        source: "local_git",
        defaultBranch: "v3",
        trustLevel: "trusted_local",
        monitoringEnabled: true,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z"
      }
    ];
    const zhHtml = renderShell("/repositories/repo_1/pull-requests", { locale: "zh-CN", repositories });
    expect(zhHtml).toContain("拉取请求");
    expect(zhHtml).not.toContain("Pull Requests");

    const enHtml = renderShell("/repositories/repo_1/pull-requests", { repositories });
    expect(enHtml).toContain("Pull Requests");
  });

  it("exposes explicit system, light, and dark theme preferences", () => {    const html = renderShell("/repositories", { themePreference: "system" });
    expect(html).toContain('aria-label="System"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Light"');
    expect(html).toContain('aria-label="Dark"');

    const zhHtml = renderShell("/repositories", { locale: "zh-CN", themePreference: "system" });
    expect(zhHtml).toContain('aria-label="跟随系统"');
    expect(zhHtml).toContain('aria-label="浅色"');
    expect(zhHtml).toContain('aria-label="深色"');
  });

  it("renders clear location breadcrumbs in the header", () => {
    const html = renderShell("/repositories/repo_1/history", {
      repositories: [
        {
          id: "repo_1",
          displayName: "ConsistenCy",
          source: "github",
          remoteFullName: "sk1ua/ConsistenCy",
          defaultBranch: "main",
          trustLevel: "untrusted_readonly",
          monitoringEnabled: false,
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z"
        }
      ]
    });
    expect(html).toContain("location-breadcrumbs");
    expect(html).toContain("Git History");
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

  it("displays real LLM provider status when configured and unconfigured link when absent without mock badge", () => {
    // Configured real provider
    const htmlConfigured = renderShell("/runs", {
      locale: "zh-CN",
      health: {
        ok: true,
        service: "consistency-api",
        database: { ok: true },
        worker: { running: true, activeJobs: 0, concurrency: 1 },
        llmConfigured: true,
        llmProvider: "DeepSeek",
        llmModel: "deepseek-chat",
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "file", configured: true },
          workerConcurrency: 1
        }
      }
    });
    expect(htmlConfigured).toContain("DeepSeek");
    expect(htmlConfigured).toContain("deepseek-chat");
    expect(htmlConfigured).not.toContain("Mock 模型");
    expect(htmlConfigured).not.toContain("Demo mode");

    // Unconfigured LLM
    const htmlUnconfigured = renderShell("/runs", {
      locale: "zh-CN",
      health: {
        ok: true,
        service: "consistency-api",
        database: { ok: true },
        worker: { running: true, activeJobs: 0, concurrency: 1 },
        llmConfigured: false,
        llmProvider: "none",
        configuration: {
          githubAppConfigured: false,
          webhookSecretConfigured: false,
          publicReadTokenConfigured: false,
          storage: { kind: "file", configured: true },
          workerConcurrency: 1
        }
      }
    });
    expect(htmlUnconfigured).toContain("LLM 未配置");
    expect(htmlUnconfigured).not.toContain("Mock 模型");
    expect(htmlUnconfigured).not.toContain("Demo mode");
  });

  it("strictly matches repository ID and does not resolve aliases for navigation", () => {
    const repos = [
      {
        id: "repo_1",
        displayName: "ConsistenCy",
        source: "github" as const,
        remoteFullName: "sk1ua/ConsistenCy",
        defaultBranch: "main",
        trustLevel: "untrusted_readonly" as const,
        monitoringEnabled: false,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z"
      }
    ];

    const htmlAlias1 = renderShell("/repositories/ConsistenCy/history", { repositories: repos });
    expect(htmlAlias1).not.toContain("ConsistenCy/history");

    const htmlAlias2 = renderShell("/repositories/sk1ua%2FConsistenCy/history", { repositories: repos });
    expect(htmlAlias2).not.toContain("sk1ua/ConsistenCy/history");

    const htmlId = renderShell("/repositories/repo_1/history", { repositories: repos });
    expect(htmlId).toContain("ConsistenCy");
    expect(htmlId).toContain("location-breadcrumbs");
  });

  it("safely handles malformed percent-encoded path segments without throwing", () => {
    const htmlMalformedRepo = renderShell("/repositories/%A/history", { repositories: [] });
    expect(htmlMalformedRepo).toContain("Invalid repository ID");
    expect(htmlMalformedRepo).toContain("location-breadcrumbs");

    const htmlMalformedRun = renderShell("/runs/%A/overview", { jobs: [] });
    expect(htmlMalformedRun).toContain("Invalid run ID");
    expect(htmlMalformedRun).toContain("location-breadcrumbs");

    const repos = [{
      id: "my%2Frepo",
      displayName: "Valid Repo",
      source: "github" as const,
      remoteFullName: "my/repo",
      defaultBranch: "main",
      trustLevel: "untrusted_readonly" as const,
      monitoringEnabled: false,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z"
    }];
    const htmlValid = renderShell("/repositories/my%252Frepo/overview", { repositories: repos });
    expect(htmlValid).toContain("Valid Repo");
  });
});
