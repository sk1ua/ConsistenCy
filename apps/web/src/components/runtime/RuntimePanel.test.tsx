import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunRuntimeSnapshot } from "@consistency/schema";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { runModeFromPath } from "../../routes/ReportRoute";
import { RuntimePanel } from "./RuntimePanel";

const mockLiveSnapshot: RunRuntimeSnapshot = {
  runId: "run_test_123",
  workloadKind: "pr_review",
  jobId: "job_test_123",
  state: "ACTIVE",
  createdAt: "2026-08-05T12:00:00.000Z",
  startedAt: "2026-08-05T12:00:01.000Z",
  concurrency: 2,
  telemetryStatus: "live",
  agentCounts: { total: 4, running: 2, waiting: 2, terminal: 0 },
  securityGuarantees: {
    processMemoryIsolation: "enforced",
    parentEnvSecretIsolation: "enforced",
    kernelRpcAuthorization: "enforced",
    filesystemOsContainment: "not-enforced",
    networkOsContainment: "not-enforced",
    subprocessOsContainment: "not-enforced",
  },
  agents: [
    {
      agentId: "agent_supervisor",
      label: "Supervisor",
      state: "RUNNING",
      priority: 10,
      children: ["agent_security", "agent_child"],
      logicalRing: 3,
      executionDomain: "in-process",
      createdAt: 1000,
      capabilities: [
        {
          action: "repo.read",
          resourceKind: "repository",
          resourceId: "owner/repo",
          handleFingerprint: "fp_sup_123456",
          revoked: false,
        },
      ],
    },
    {
      agentId: "agent_security",
      label: "Security",
      state: "WAIT_LLM",
      priority: 5,
      parent: "agent_supervisor",
      children: [],
      logicalRing: 3,
      executionDomain: "in-process",
      pendingOperation: {
        kind: "llm",
        description: "LLM Provider (openai)",
        startedAt: 2000,
      },
      createdAt: 1050,
      capabilities: [
        {
          action: "llm.invoke",
          resourceKind: "llm",
          resourceId: "openai",
          handleFingerprint: "fp_sec_789012",
          revoked: false,
        },
      ],
    },
    {
      agentId: "agent_tool",
      label: "ToolAgent",
      state: "WAIT_TOOL",
      priority: 3,
      parent: "agent_supervisor",
      children: [],
      logicalRing: 3,
      executionDomain: "in-process",
      pendingOperation: {
        kind: "tool",
        description: "Tool (git.diff)",
        startedAt: 2100,
      },
      createdAt: 1100,
      capabilities: [],
    },
    {
      agentId: "agent_child",
      label: "ChildPlugin",
      state: "RUNNING",
      priority: 1,
      parent: "agent_supervisor",
      children: [],
      logicalRing: 3,
      executionDomain: "child-process",
      createdAt: 1150,
      capabilities: [],
      sandbox: {
        sessionId: "sbx_proc_1",
        state: "running",
        pid: 9988,
        pluginId: "plugin-sec",
        pluginVersion: "1.0.0",
        executionDomain: "child-process",
        protocolVersion: 1,
      },
    },
  ],
  context: {
    baseContextImageId: "img_base_1",
    workingSetTokens: 1250,
    workingSetPageCount: 4,
    pageCountsByKind: { source: 2, policy: 1, evidence: 1 },
    pageCountsByResidency: { pinned: 1, hot: 2, cold: 1, evicted: 0 },
    pages: [
      {
        pageId: "page_1",
        kind: "policy",
        residency: "pinned",
        estimatedTokens: 100,
        contentHash: "hash12345678",
      },
      {
        pageId: "page_2",
        kind: "source",
        residency: "hot",
        estimatedTokens: 500,
        contentHash: "hash87654321",
        sourceRef: "src/index.ts",
      },
    ],
  },
};

const mockCompletedSnapshot: RunRuntimeSnapshot = {
  ...mockLiveSnapshot,
  telemetryStatus: "completed",
  state: "SUCCEEDED",
};

const mockUnavailableSnapshot: RunRuntimeSnapshot = {
  ...mockLiveSnapshot,
  telemetryStatus: "unavailable",
  agents: [],
};

import { workspaceQueryKeys } from "../../query/client";

function renderWithProviders(
  component: React.ReactNode,
  locale: "zh-CN" | "en-US" = "en-US",
  initialData?: RunRuntimeSnapshot,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (initialData) {
    queryClient.setQueryData(workspaceQueryKeys.runtimeSnapshot("run_test_123"), initialData);
  }
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{component}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Web Task Manager (AC-WEB-TM-1..10)", () => {
  it("AC-WEB-TM-1: /runs/:runId/runtime route selects runtime mode", () => {
    expect(runModeFromPath("/runs/run-123/runtime")).toBe("runtime");
    expect(runModeFromPath("/runs/run-123/overview")).toBe("overview");
  });

  it("AC-WEB-TM-2..3: renders Agent process hierarchy, labels, and RUNNING / WAIT_LLM / WAIT_TOOL states", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockLiveSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockLiveSnapshot);

    expect(html).toContain("Supervisor");
    expect(html).toContain("Security");
    expect(html).toContain("ToolAgent");
    expect(html).toContain("ChildPlugin");

    expect(html).toContain("RUNNING");
    expect(html).toContain("WAIT_LLM");
    expect(html).toContain("WAIT_TOOL");
    expect(html).toContain("LLM Provider (openai)");
  });

  it("AC-WEB-TM-4: Context PINNED / HOT / COLD / EVICTED residency counts render", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockLiveSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockLiveSnapshot);

    expect(html).toMatch(/PINNED[\s\S]*1/);
    expect(html).toMatch(/HOT[\s\S]*2/);
    expect(html).toMatch(/COLD[\s\S]*1/);
    expect(html).toMatch(/EVICTED[\s\S]*0/);
    expect(html).toContain("1,250"); // Working set tokens
  });

  it("AC-WEB-TM-5: Capability action / resource / fingerprint render, raw handle NEVER renders", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockLiveSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockLiveSnapshot);

    expect(html).not.toContain("cap_");
    expect(html).not.toContain("Copy capability token");
  });

  it("AC-WEB-TM-6: in-process vs child-process execution domains render distinctly", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockLiveSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockLiveSnapshot);

    expect(html).toContain("in-process");
    expect(html).toContain("child-process");
    expect(html).toMatch(/PID[\s\S]*9988/);
  });

  it("AC-WEB-TM-7: Security guarantees section truthfully displays NOT ENFORCED for containment dimensions", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockLiveSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockLiveSnapshot);

    expect(html).toContain("Filesystem OS Containment");
    expect(html).toContain("Network OS Containment");
    expect(html).toContain("Subprocess OS Containment");
    expect(html).toContain("NOT ENFORCED");
  });

  it("AC-WEB-TM-8: completed snapshot is visually distinguished from live", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockCompletedSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockCompletedSnapshot);

    expect(html).toContain("COMPLETED SNAPSHOT");
    expect(html).not.toContain("LIVE");
  });

  it("AC-WEB-TM-9: unavailable telemetry displays explicit empty state", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockUnavailableSnapshot);

    const html = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockUnavailableSnapshot);

    expect(html).toContain("Runtime Telemetry Unavailable");
  });

  it("AC-WEB-TM-10: zh-CN and en-US strings exist for task manager UI", () => {
    vi.spyOn(api, "runtimeSnapshot").mockResolvedValue(mockLiveSnapshot);

    const htmlZh = renderWithProviders(<RuntimePanel runId="run_test_123" />, "zh-CN", mockLiveSnapshot);
    expect(htmlZh).toContain("实时运行");
    expect(htmlZh).toContain("能力");
    expect(htmlZh).toContain("文件系统 OS 隔离");
    expect(htmlZh).toContain("未强制");

    const htmlEn = renderWithProviders(<RuntimePanel runId="run_test_123" />, "en-US", mockLiveSnapshot);
    expect(htmlEn).toContain("LIVE");
    expect(htmlEn).toContain("Filesystem OS Containment");
    expect(htmlEn).toContain("NOT ENFORCED");
  });
});
