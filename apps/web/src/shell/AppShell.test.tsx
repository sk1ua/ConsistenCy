import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell, isCommandPaletteShortcut } from "./AppShell";

function renderShell(path = "/runs", overrides = {}): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <AppShell
        path={path}
        routeHref={path}
        meta={{ title: "Audit runs", shortTitle: "Runs", description: "Review runs", section: "Reviews" }}
        locale="en-US"
        setLocale={() => undefined}
        themePreference="dark"
        themeLabel="Dark"
        cycleTheme={() => undefined}
        jobs={[]}
        pulse={null}
        healthUnavailable={false}
        notices={[]}
        refreshing={false}
        onRefresh={() => undefined}
        {...overrides}
      >
        <p>Route content</p>
      </AppShell>
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

  it("renders clear location breadcrumbs in the header", () => {
    const html = renderShell("/repositories/sk1ua%2FConsistenCy/history");
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
});
