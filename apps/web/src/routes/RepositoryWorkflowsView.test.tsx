/**
 * RepositoryWorkflowsView — CKPT5 trigger-mode UI tests.
 *
 *   U1  binding rows expose the trigger-mode selector reflecting the stored
 *       mode, with the automatic-trigger hint ONLY for enabled on_change
 *       bindings (zh + en).
 *   U2  changing the selector persists the mode through the binding PUT
 *       (enabled state is carried along unchanged).
 *   U3  run history rows carry trigger provenance badges (manual / change,
 *       with the event id as title); runs without provenance (pre-CKPT5
 *       rows) show no badge.
 */
// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type {
  WorkflowRuntimeBinding,
  WorkflowRuntimeDefinitionSummary,
  WorkflowRuntimeRunSummary
} from "@consistency/schema";

const setWorkflowRuntimeBinding = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    workflowRuntimeBindings: vi.fn(async () => bindingsFixture),
    workflowRuntimeDefinitions: vi.fn(async () => definitionsFixture),
    workflowRuntimeRunsForRepository: vi.fn(async () => runsFixture),
    setWorkflowRuntimeBinding: (...args: unknown[]) => setWorkflowRuntimeBinding(...args),
    triggerWorkflowRuntimeForRepository: vi.fn(),
    workflowRuntimeRunV2: vi.fn()
  }
}));

const date = "2026-08-25T00:00:00.000Z";
const definitionSummary: WorkflowRuntimeDefinitionSummary = {
  definitionId: "verified-mini-review",
  origin: "builtin",
  latestRevision: 1,
  latestRevisionId: "wfrev_1",
  status: "validated",
  createdAt: date,
  updatedAt: date
};

let bindingsFixture: WorkflowRuntimeBinding[] = [];
const definitionsFixture: WorkflowRuntimeDefinitionSummary[] = [definitionSummary];
let runsFixture: WorkflowRuntimeRunSummary[] = [];

import { RepositoryWorkflowsView } from "./RepositoryWorkflowsView";

async function renderView(zh: boolean): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RepositoryWorkflowsView repositoryId="repo-1" zh={zh} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  // Flush the initial react-query resolutions before asserting.
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
  return { root, container };
}

afterEach(async () => {
  bindingsFixture = [];
  runsFixture = [];
  setWorkflowRuntimeBinding.mockClear();
  document.body.innerHTML = "";
});

describe("RepositoryWorkflowsView trigger modes (CKPT5)", () => {
  it("U1 selector reflects stored mode; automatic-trigger hint only for enabled on_change bindings", async () => {
    bindingsFixture = [
      {
        repositoryId: "repo-1",
        definitionId: "verified-mini-review",
        enabled: true,
        triggerMode: "on_change",
        definition: definitionSummary,
        createdAt: date,
        updatedAt: date
      },
      {
        repositoryId: "repo-1",
        definitionId: "user-def",
        enabled: true,
        triggerMode: "manual",
        definition: definitionSummary,
        createdAt: date,
        updatedAt: date
      }
    ];
    const { container } = await renderView(true);
    const selects = Array.from(container.querySelectorAll("select"));
    const modeSelect = selects.find(select => select.getAttribute("aria-label") === "触发模式")!;
    expect(modeSelect).toBeTruthy();
    expect((modeSelect as HTMLSelectElement).value).toBe("on_change");
    expect(container.textContent).toContain("仓库变更事件将自动触发");

    // The manual binding shows no hint and its selector reads manual.
    const manualSelects = selects.filter(select => (select as HTMLSelectElement).value === "manual");
    expect(manualSelects.length).toBe(1);
  });

  it("U2 changing the selector persists the mode with the current enabled state", async () => {
    bindingsFixture = [
      {
        repositoryId: "repo-1",
        definitionId: "verified-mini-review",
        enabled: true,
        triggerMode: "manual",
        definition: definitionSummary,
        createdAt: date,
        updatedAt: date
      }
    ];
    const { container } = await renderView(true);
    const modeSelect = Array.from(container.querySelectorAll("select"))
      .find(select => select.getAttribute("aria-label") === "触发模式") as HTMLSelectElement;
    await act(async () => {
      modeSelect.value = "on_change";
      modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setWorkflowRuntimeBinding).toHaveBeenCalledWith("repo-1", "verified-mini-review", true, "on_change");
  });

  it("U3 run history badges provenance; runs without provenance show none", async () => {
    runsFixture = [
      {
        runId: "wfrun_auto",
        definitionId: "verified-mini-review",
        revisionId: "wfrev_1",
        status: "succeeded",
        createdAt: date,
        repository: "test/repo-1",
        headSha: "head123",
        findingCount: 1,
        evidenceCount: 2,
        trigger: { source: "repository_change", eventId: "repository_event_auto" }
      },
      {
        runId: "wfrun_manual",
        definitionId: "verified-mini-review",
        revisionId: "wfrev_1",
        status: "succeeded",
        createdAt: date,
        repository: "test/repo-1",
        headSha: "head123",
        findingCount: 0,
        evidenceCount: 1,
        trigger: { source: "manual" }
      },
      {
        runId: "wfrun_legacy",
        definitionId: "verified-mini-review",
        revisionId: "wfrev_1",
        status: "failed",
        createdAt: date,
        repository: "test/repo-1",
        headSha: "head123",
        findingCount: 0,
        evidenceCount: 0
      }
    ];
    const { container } = await renderView(true);
    const badges = Array.from(container.querySelectorAll('[role="listitem"] span[title]'));
    expect(badges.length).toBe(1);
    expect(badges[0]!.textContent).toContain("变更触发");
    expect(badges[0]!.getAttribute("title")).toBe("repository_event_auto");
    expect(container.textContent).toContain("手动");
    // The pre-CKPT5 row contributes neither badge variant beyond the two above.
    const manualBadges = Array.from(container.querySelectorAll('[role="listitem"] span')).filter(span => span.textContent === "手动");
    expect(manualBadges.length).toBe(1);
  });
});
