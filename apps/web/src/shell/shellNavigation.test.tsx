// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository, ReviewJob } from "@consistency/schema";
import { RelatedCards } from "./RelatedCards";
import { RepoDirectoryPanel } from "./RepoDirectoryPanel";
import { ReviewWorkbench } from "./ReviewWorkbench";
import { AutomationPage } from "../routes/AutomationPage";
import { PluginsPage } from "../routes/PluginsPage";
import { I18nProvider } from "../i18n";
import { api } from "../api/client";

const originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

let root: Root | undefined;

const demoRepo: Repository = {
  id: "repo_1",
  displayName: "ConsistenCy",
  source: "local_git",
  defaultBranch: "v3",
  trustLevel: "trusted_local",
  monitoringEnabled: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z"
};

const demoJob = {
  id: "job_abc123",
  type: "PR_REVIEW",
  repositoryId: "repo_1",
  repositoryFullName: "ConsistenCy",
  status: "succeeded",
  accessMode: "local_git",
  publicationPolicy: "disabled",
  createdAt: "2026-08-18T01:00:00.000Z",
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  baseSha: "1234567890abcdef1234567890abcdef12345678",
  report: {
    jobId: "job_abc123",
    repositoryFullName: "ConsistenCy",
    baseSha: "1234567890abcdef1234567890abcdef12345678",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    score: 88,
    riskLevel: "low",
    findings: [],
    agentRuns: [],
    summary: "ok",
    createdAt: "2026-08-18T01:05:00.000Z"
  }
} as ReviewJob;

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe" data-path={location.pathname} />;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true
  });
  sessionStorage.clear();
  vi.spyOn(api, "reviewPreparation").mockResolvedValue({
    repository: {
      id: demoRepo.id,
      displayName: demoRepo.displayName,
      sourceKind: "local_git",
      trust: "trusted_local"
    },
    sources: {
      workingTree: { available: true, changedFileCount: 2 },
      branch: { available: true, base: "v3", head: "abcdef1234567890abcdef1234567890abcdef12" }
    },
    model: {
      default: { provider: "openai", model: "gpt-demo" },
      providers: [{ id: "openai", label: "OpenAI", configured: true }],
      pendingRestart: null
    },
    canStartReview: true,
    blockingReasons: []
  } as never);
  vi.spyOn(api, "repositoryGitStatus").mockResolvedValue({
    repositoryId: demoRepo.id,
    available: true,
    branch: "v3",
    headSha: "abcdef1234567890",
    dirtyFileCount: 2,
    untrackedFileCount: 1,
    changedFiles: [
      { path: "apps/web/src/shell/AppShell.tsx", status: "modified" },
      { path: "README.md", status: "modified" }
    ],
    untrackedFiles: ["scratch.tmp"],
    remotes: []
  } as never);
  vi.spyOn(api, "repositoryTree").mockImplementation(async (_id: string, path = "") => {
    if (path === "apps") {
      return {
        repositoryId: demoRepo.id,
        available: true,
        revision: "abcdef1234567890abcdef1234567890abcdef12",
        path: "apps",
        truncated: false,
        entries: [
          { path: "apps/web", name: "web", type: "tree", changeKind: "changed" }
        ]
      } as never;
    }
    if (path === "apps/web") {
      return {
        repositoryId: demoRepo.id,
        available: true,
        revision: "abcdef1234567890abcdef1234567890abcdef12",
        path: "apps/web",
        truncated: false,
        entries: [
          { path: "apps/web/src", name: "src", type: "tree", changeKind: "changed" }
        ]
      } as never;
    }
    if (path === "apps/web/src") {
      return {
        repositoryId: demoRepo.id,
        available: true,
        revision: "abcdef1234567890abcdef1234567890abcdef12",
        path: "apps/web/src",
        truncated: false,
        entries: [
          { path: "apps/web/src/shell", name: "shell", type: "tree", changeKind: "changed" }
        ]
      } as never;
    }
    if (path === "apps/web/src/shell") {
      return {
        repositoryId: demoRepo.id,
        available: true,
        revision: "abcdef1234567890abcdef1234567890abcdef12",
        path: "apps/web/src/shell",
        truncated: false,
        entries: [
          {
            path: "apps/web/src/shell/AppShell.tsx",
            name: "AppShell.tsx",
            type: "blob",
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: 1200,
            changeKind: "changed"
          }
        ]
      } as never;
    }
    return {
      repositoryId: demoRepo.id,
      available: true,
      revision: "abcdef1234567890abcdef1234567890abcdef12",
      path: "",
      truncated: false,
      entries: [
        { path: "apps", name: "apps", type: "tree", changeKind: "changed" },
        {
          path: "README.md",
          name: "README.md",
          type: "blob",
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          size: 420,
          changeKind: "changed"
        },
        {
          path: "scratch.tmp",
          name: "scratch.tmp",
          type: "blob",
          changeKind: "untracked"
        },
        {
          path: "clean.ts",
          name: "clean.ts",
          type: "blob",
          sha: "cccccccccccccccccccccccccccccccccccccccc",
          size: 32,
          changeKind: "unchanged"
        }
      ]
    } as never;
  });
  vi.spyOn(api, "repositoryFileContent").mockImplementation(async (_id: string, path: string) => {
    if (path === "clean.ts") {
      return {
        repositoryId: demoRepo.id,
        path: "clean.ts",
        available: true,
        encoding: "utf-8",
        truncated: false,
        size: 32,
        content: "export const clean = true;\n",
        binary: false
      } as never;
    }
    return {
      repositoryId: demoRepo.id,
      path,
      available: true,
      encoding: "utf-8",
      truncated: false,
      size: 12,
      content: "// preview\n",
      binary: false
    } as never;
  });
  vi.spyOn(api, "engineAllowlistCatalog").mockResolvedValue({
    catalog: {
      analyzers: ["engine.style", "engine.security"],
      verifiers: ["verify.syntax"],
      synthesizerKinds: ["synthesize.review_report"],
      builtinWorkflows: [],
      engineLegacyBuiltins: [],
      runtimeVerifiedBuiltins: []
    }
  } as never);
  vi.spyOn(api, "repositoryReviews").mockResolvedValue([demoJob] as never);
  vi.spyOn(api, "workflowRuntimeBindings").mockResolvedValue([
    {
      definitionId: "verified-mini-review",
      repositoryId: demoRepo.id,
      enabled: true,
      triggerMode: "manual"
    }
  ] as never);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
  if (originalActEnvironmentDescriptor) {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironmentDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
  document.body.innerHTML = "";
  sessionStorage.clear();
});

async function mount(node: ReactNode, entry = "/inbox") {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="zh-CN">
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="*" element={<>{node}<LocationProbe /></>} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  // allow queries to settle
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

function pathOf(host: HTMLElement): string {
  return host.querySelector("[data-testid=location-probe]")?.getAttribute("data-path") ?? "";
}

describe("shell navigation happy path", () => {
  it("related cards jump to overview, reviews, and workflows", async () => {
    const host = await mount(
      <RelatedCards locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
    );

    const jumpButtons = [...host.querySelectorAll<HTMLButtonElement>(".related-card__jump")];
    expect(jumpButtons.map(b => b.textContent)).toEqual(
      expect.arrayContaining(["打开概览", "打开审查列表", "打开工作流绑定"])
    );

    await act(async () => {
      jumpButtons.find(b => b.textContent?.includes("打开概览"))!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/overview");

    await act(async () => {
      jumpButtons.find(b => b.textContent?.includes("打开审查列表"))!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/reviews");

    await act(async () => {
      jumpButtons.find(b => b.textContent?.includes("打开工作流绑定"))!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/workflows");
  });

  it("recent review row navigates to run overview", async () => {
    const host = await mount(
      <RelatedCards locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
    );
    const link = [...host.querySelectorAll<HTMLButtonElement>(".related-card__link")].find(b =>
      b.textContent?.includes("工作区审查")
    );
    expect(link).toBeTruthy();
    await act(async () => {
      link!.click();
    });
    expect(pathOf(host)).toBe("/runs/job_abc123/overview");
  });

  it("directory panel file click opens changes view", async () => {
    const host = await mount(
      <RepoDirectoryPanel
        isOpen
        onClose={() => undefined}
        repositoryId={demoRepo.id}
        displayName={demoRepo.displayName}
        locale="zh-CN"
      />
    );
    let fileBtn: HTMLButtonElement | undefined;
    for (let i = 0; i < 30 && !fileBtn; i++) {
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });
      fileBtn = [...host.querySelectorAll<HTMLButtonElement>(".repo-directory-list__item")].find(b =>
        b.textContent?.includes("README.md")
      );
    }
    expect(host.textContent).toMatch(/目录树|Tree/);
    expect(host.textContent).toMatch(/README\.md|apps/);
    expect(fileBtn).toBeTruthy();
    await act(async () => {
      fileBtn!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/changes");
  });

  it("directory panel navigates with highlightPath state", async () => {
    let lastState: unknown;
    function StateProbe() {
      const location = useLocation();
      lastState = location.state;
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <I18nProvider initialLocale="zh-CN">
            <MemoryRouter initialEntries={["/inbox"]}>
              <Routes>
                <Route path="*" element={<>
                  <RepoDirectoryPanel
                    isOpen
                    onClose={() => undefined}
                    repositoryId={demoRepo.id}
                    displayName={demoRepo.displayName}
                    locale="zh-CN"
                  />
                  <StateProbe />
                  <LocationProbe />
                </>} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 30));
    });
    const fileBtn = [...host.querySelectorAll<HTMLButtonElement>(".repo-directory-list__item")].find(b =>
      b.textContent?.includes("README.md")
    );
    expect(fileBtn).toBeTruthy();
    await act(async () => {
      fileBtn!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/changes");
    expect(lastState).toEqual({ highlightPath: "README.md" });
  });

  it("directory panel shows tree and clean-file content preview", async () => {
    const host = await mount(
      <RepoDirectoryPanel
        isOpen
        onClose={() => undefined}
        repositoryId={demoRepo.id}
        displayName={demoRepo.displayName}
        locale="zh-CN"
      />
    );
    let cleanBtn: HTMLButtonElement | undefined;
    for (let i = 0; i < 30 && !cleanBtn; i++) {
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });
      cleanBtn = [...host.querySelectorAll<HTMLButtonElement>(".repo-directory-list__item")].find(b =>
        b.textContent?.includes("clean.ts")
      );
    }
    expect(cleanBtn).toBeTruthy();
    await act(async () => {
      cleanBtn!.click();
    });
    expect(pathOf(host)).toBe("/inbox");
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });
      if (host.querySelector("[data-testid=repo-directory-preview-code]")) break;
    }
    const preview = host.querySelector("[data-testid=repo-directory-preview]");
    expect(preview?.textContent).toMatch(/clean\.ts/);
    expect(preview?.textContent).toMatch(/干净|Clean/);
    const code = host.querySelector("[data-testid=repo-directory-preview-code]");
    expect(code?.textContent).toMatch(/export const clean/);
  });

  it("workbench surfaces and review rows navigate correctly", async () => {
    const host = await mount(
      <ReviewWorkbench locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
    );
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });

    const surfaces = [...host.querySelectorAll<HTMLButtonElement>(".review-workbench__surface")];
    expect(surfaces.map(s => s.textContent)).toEqual(
      expect.arrayContaining(["概览", "变更", "历史", "PR", "审查", "工作流"])
    );

    await act(async () => {
      surfaces.find(s => s.textContent === "变更")!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/changes");

    // remount for review row (path already changed)
  });

  it("workbench recent review row opens /runs/:id/overview", async () => {
    const host = await mount(
      <ReviewWorkbench locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
    );
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });
    const row = [...host.querySelectorAll<HTMLButtonElement>(".review-workbench__row")].find(b =>
      b.textContent?.includes("工作区审查")
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
    });
    expect(pathOf(host)).toBe("/runs/job_abc123/overview");
  });

  it("automation page exposes a clear back path to the workbench", async () => {
    const host = await mount(<AutomationPage automations={[]} repositories={[]} />, "/automation");
    const back = [...host.querySelectorAll("a")].find(a =>
      a.textContent?.includes("返回审查工作台") || a.textContent?.includes("返回工作台")
    );
    expect(back).toBeTruthy();
    expect(back!.getAttribute("href")).toContain("/inbox");
  });

  it("plugins page lists builtin analyzers without a fake marketplace", async () => {
    const host = await mount(<PluginsPage />, "/plugins");
    expect(host.querySelector('[data-testid="plugins-page"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="plugin-builtin-style"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="plugin-builtin-secret"]')).toBeTruthy();
    expect(host.textContent).toMatch(/第三方市场稍后|third-party marketplace later/i);
    const back = [...host.querySelectorAll("a")].find(a =>
      a.textContent?.includes("返回审查工作台") || a.textContent?.includes("返回工作台")
    );
    expect(back).toBeTruthy();
  });

  it("related evidence card jumps to run evidence", async () => {
    const host = await mount(
      <RelatedCards locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
    );
    const jump = [...host.querySelectorAll<HTMLButtonElement>(".related-card__jump")].find(b =>
      b.textContent?.includes("查看证据")
    );
    expect(jump).toBeTruthy();
    await act(async () => {
      jump!.click();
    });
    expect(pathOf(host)).toBe("/runs/job_abc123/evidence");
  });

  it("workbench change row navigates with highlightPath", async () => {
    let lastState: unknown;
    function StateProbe() {
      const location = useLocation();
      lastState = location.state;
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <I18nProvider initialLocale="zh-CN">
            <MemoryRouter initialEntries={["/inbox"]}>
              <Routes>
                <Route path="*" element={<>
                  <ReviewWorkbench locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
                  <StateProbe />
                  <LocationProbe />
                </>} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });
    const row = [...host.querySelectorAll<HTMLButtonElement>(".review-workbench__row")].find(b =>
      b.textContent?.includes("README.md")
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
    });
    expect(pathOf(host)).toBe("/repositories/repo_1/changes");
    expect(lastState).toEqual({ highlightPath: "README.md" });
  });


  it("workbench shows success disposition CTA to run overview", async () => {
    const host = await mount(
      <ReviewWorkbench locale="zh-CN" repository={demoRepo} jobs={[demoJob]} />
    );
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });
    const banner = host.querySelector('[data-testid="review-workbench-disposition"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toMatch(/审查已完成|打开运行概览/);
    const cta = [...banner!.querySelectorAll("button")].find(b =>
      b.textContent?.includes("打开运行概览")
    );
    expect(cta).toBeTruthy();
    await act(async () => {
      cta!.click();
    });
    expect(pathOf(host)).toBe("/runs/job_abc123/overview");
  });

  it("workbench shows failed job error summary with run link", async () => {
    const failedJob = {
      ...demoJob,
      id: "job_fail_1",
      status: "failed" as const,
      error: "Agent pipeline aborted: model returned empty findings",
      report: undefined
    };
    vi.spyOn(api, "repositoryReviews").mockResolvedValue([failedJob] as never);
    const host = await mount(
      <ReviewWorkbench locale="zh-CN" repository={demoRepo} jobs={[failedJob]} />
    );
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });
    const banner = host.querySelector('[data-testid="review-workbench-disposition"]');
    expect(banner).toBeTruthy();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toMatch(/审查失败/);
    expect(banner?.textContent).toMatch(/Agent pipeline aborted/);
    const cta = [...banner!.querySelectorAll("button")].find(b =>
      b.textContent?.includes("查看失败详情")
    );
    expect(cta).toBeTruthy();
    await act(async () => {
      cta!.click();
    });
    expect(pathOf(host)).toBe("/runs/job_fail_1/overview");
  });

});
