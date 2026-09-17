import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell, isCommandPaletteShortcut } from "./AppShell";

function renderShell(path = "/runs", overrides = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  return renderToString(
    <QueryClientProvider client={client}>
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
    </QueryClientProvider>
  );
}

const demoRepo = {
  id: "repo_1",
  displayName: "ConsistenCy",
  source: "local_git" as const,
  defaultBranch: "v3",
  trustLevel: "trusted_local" as const,
  monitoringEnabled: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z"
};

describe("Locked three-column AppShell", () => {
  it("renders three-column agent shell without VS Code activity rail or chat tabs", () => {
    const html = renderShell("/inbox", { repositories: [demoRepo] });

    expect(html).toContain("agent-shell");
    expect(html).toContain("repo-first-sidebar");
    expect(html).toContain("related-cards-rail");
    expect(html).toContain("ConsistenCy");
    expect(html).not.toContain("activity-rail");
    expect(html).not.toContain("workbench-tabs");
    expect(html).not.toContain("run-ledger-toggle");
    expect(html).not.toContain("对话");
    expect(html).not.toContain("Chat");
  });

  it("lists connected repos with status and directory actions", () => {
    const html = renderShell("/inbox", {
      locale: "zh-CN",
      repositories: [demoRepo]
    });
    expect(html).toContain("仓库情况");
    expect(html).toContain("仓库目录");
    expect(html).toContain("自动化");
    expect(html).toContain("插件市场");
  });

  it("localizes the pull-requests breadcrumb per locale", () => {
    const repositories = [demoRepo];
    const zhHtml = renderShell("/repositories/repo_1/pull-requests", { locale: "zh-CN", repositories });
    expect(zhHtml).toContain("拉取请求");
    expect(zhHtml).not.toContain("Pull Requests");

    const enHtml = renderShell("/repositories/repo_1/pull-requests", { repositories });
    expect(enHtml).toContain("Pull Requests");
  });

  it("exposes a quiet single theme cycle control in the top bar", () => {
    const html = renderShell("/repositories", { themePreference: "system" });
    expect(html).toContain('aria-label="Cycle theme"');
    expect(html).toContain("lucide-monitor");

    const light = renderShell("/repositories", { themePreference: "light" });
    expect(light).toContain("lucide-sun");

    const dark = renderShell("/repositories", { themePreference: "dark" });
    expect(dark).toContain("lucide-moon");

    const zhHtml = renderShell("/repositories", { locale: "zh-CN", themePreference: "system" });
    expect(zhHtml).toContain('aria-label="切换主题"');
  });

  it("renders clear location breadcrumbs in the header", () => {
    const html = renderShell("/repositories/repo_1/history", {
      repositories: [
        {
          ...demoRepo,
          source: "github",
          remoteFullName: "sk1ua/ConsistenCy",
          defaultBranch: "main",
          trustLevel: "untrusted_readonly",
          monitoringEnabled: false
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

  it("shows LLM provenance in the top-bar chip (not a bottom status bar) without mock badge", () => {
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
    expect(htmlConfigured).toContain("agent-shell__provenance");
    expect(htmlConfigured).not.toContain("agent-shell__status");
    expect(htmlConfigured).not.toContain("data-shell-status");
    expect(htmlConfigured).not.toContain("Mock 模型");
    expect(htmlConfigured).not.toContain("Demo mode");

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
        ...demoRepo,
        source: "github" as const,
        remoteFullName: "sk1ua/ConsistenCy",
        defaultBranch: "main",
        trustLevel: "untrusted_readonly" as const,
        monitoringEnabled: false
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
