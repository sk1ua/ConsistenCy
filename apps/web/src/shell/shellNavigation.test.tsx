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
import { ComingSoonPage } from "../routes/ComingSoonPage";
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
    for (let i = 0; i < 20 && !fileBtn; i++) {
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });
      fileBtn = [...host.querySelectorAll<HTMLButtonElement>(".repo-directory-list__item")].find(b =>
        b.textContent?.includes("README.md")
      );
    }
    expect(host.textContent).toMatch(/已变更|未跟踪/);
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

  it("automation stub exposes a clear back path to the workbench", async () => {
    const host = await mount(<ComingSoonPage kind="automation" />, "/automation");
    const back = [...host.querySelectorAll("a")].find(a =>
      a.textContent?.includes("返回审查工作台") || a.textContent?.includes("返回工作台")
    );
    expect(back).toBeTruthy();
    expect(back!.getAttribute("href")).toContain("/inbox");
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

});
