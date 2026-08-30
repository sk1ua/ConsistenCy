// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowRuntimeRunSummary,
  WorkflowRuntimeRunV2
} from "@consistency/schema";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { WorkflowRuntimeRunOverlay } from "./WorkflowRuntimeRunOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runSummary: WorkflowRuntimeRunSummary = {
  runId: "run-1",
  definitionId: "verified-mini-review",
  revisionId: "wfrev_builtin_verified-mini-review_v1",
  status: "succeeded",
  createdAt: "2026-08-28T00:00:00.000Z",
  finishedAt: "2026-08-28T00:00:05.000Z",
  repository: "local",
  headSha: "a".repeat(40),
  findingCount: 1,
  evidenceCount: 3
};

function finishedRun(): WorkflowRuntimeRunV2 {
  return {
    runId: "run-1",
    definitionId: "verified-mini-review",
    revisionId: "wfrev_builtin_verified-mini-review_v1",
    origin: "builtin",
    status: "succeeded",
    createdAt: "2026-08-28T00:00:00.000Z",
    finishedAt: "2026-08-28T00:00:05.000Z",
    snapshot: { repository: "local", headSha: "a".repeat(40) },
    evidence: [],
    miniReport: {
      definitionId: "verified-mini-review",
      runId: "run-1",
      status: "succeeded",
      repository: "local",
      headSha: "a".repeat(40),
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: "2026-08-28T00:00:05.000Z",
      evidenceCount: 3,
      verifiedEvidenceCount: 3,
      findings: [],
      agents: [
        { nodeId: "analyze", agentId: "fiber-analyze-1", state: "completed", fiberApplied: 2 },
        { nodeId: "verify", agentId: "fiber-verify-1", state: "completed", fiberApplied: 1 }
      ],
      audit: { allowed: 5, denied: 0 }
    }
  };
}

function runningRun(): WorkflowRuntimeRunV2 {
  return {
    runId: "run-2",
    definitionId: "verified-mini-review",
    revisionId: "wfrev_builtin_verified-mini-review_v1",
    origin: "builtin",
    status: "running",
    createdAt: "2026-08-28T00:01:00.000Z",
    snapshot: { repository: "local", headSha: "a".repeat(40) },
    evidence: []
  };
}

let root: Root | undefined;

async function renderOverlay(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en-US">
        <QueryClientProvider client={queryClient}>
          <WorkflowRuntimeRunOverlay />
        </QueryClientProvider>
      </I18nProvider>
    );
  });
  await settle();
  return host;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
  await act(async () => { await Promise.resolve(); });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.spyOn(api, "workflowRuntimeRuns").mockResolvedValue([runSummary]);
  vi.spyOn(api, "workflowRuntimeRunV2").mockResolvedValue(finishedRun());
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("WorkflowRuntimeRunOverlay read-only contract", () => {
  it("renders the honest empty state when no runs exist", async () => {
    vi.spyOn(api, "workflowRuntimeRuns").mockResolvedValue([]);
    const host = await renderOverlay();
    expect(host.textContent).toContain("No workflow runtime runs yet (empty, not unavailable).");
    expect(host.querySelector(".xray-overlay-picker")).toBeNull();
  });

  it("keeps the section honest when the run history endpoint fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(api, "workflowRuntimeRuns").mockRejectedValue(new Error("down"));
    const host = await renderOverlay();
    expect(host.querySelector("[data-testid='xray-runtime-runs-error']")).toBeTruthy();
    expect(host.textContent).toContain("stays empty instead of guessing");
  });

  it("overlays a finished run's per-node executions without mapping them onto pipeline members", async () => {
    const host = await renderOverlay();
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await choose(select, "run-1");
    expect(host.querySelector("[data-testid='xray-runtime-run-detail']")).toBeTruthy();
    expect(host.textContent).toContain("Run status: succeeded");
    expect(host.textContent).toContain("analyze");
    expect(host.textContent).toContain("verify");
    expect(host.textContent).toContain("fiberApplied 2");
    expect(host.textContent).toContain("5 allowed · 0 denied");
    expect(host.textContent).toContain("not the LLM review pipeline agent names");
  });

  it("says a running run exposes no per-node state yet", async () => {
    vi.spyOn(api, "workflowRuntimeRuns").mockResolvedValue([{ ...runSummary, runId: "run-2", status: "running", finishedAt: undefined, findingCount: 0 }]);
    vi.spyOn(api, "workflowRuntimeRunV2").mockResolvedValue(runningRun());
    const host = await renderOverlay();
    await choose(host.querySelector<HTMLSelectElement>("select")!, "run-2");
    expect(host.textContent).toContain("exposes no per-node state yet");
    expect(host.textContent).not.toContain("Recorded node executions");
  });

  it("shows the run detail failure state without a substitute", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(api, "workflowRuntimeRunV2").mockRejectedValue(new Error("down"));
    const host = await renderOverlay();
    await choose(host.querySelector<HTMLSelectElement>("select")!, "run-1");
    expect(host.querySelector("[data-testid='xray-runtime-run-error']")).toBeTruthy();
  });
});
