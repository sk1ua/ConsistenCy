// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Repository,
  WorkflowRuntimeBinding,
  WorkflowRuntimeDefinitionSummary,
  WorkflowRuntimeRunV2
} from "@consistency/schema";
import { api } from "../api/client";
import { I18nProvider } from "../i18n";
import { ReviewWizardDialog } from "./ReviewWizardDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repository: Repository = {
  id: "repo-local",
  displayName: "local",
  source: "local_git",
  trustLevel: "trusted_local",
  monitoringEnabled: false,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

const summary: WorkflowRuntimeDefinitionSummary = {
  definitionId: "verified-mini-review",
  origin: "builtin",
  latestRevision: 1,
  latestRevisionId: "wfrev_builtin_verified-mini-review_v1",
  status: "validated",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

const binding: WorkflowRuntimeBinding = {
  repositoryId: repository.id,
  definitionId: summary.definitionId,
  enabled: true,
  triggerMode: "manual",
  definition: summary,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

function runningRun(): WorkflowRuntimeRunV2 {
  return {
    runId: "run-1",
    definitionId: summary.definitionId,
    revisionId: summary.latestRevisionId!,
    origin: "builtin",
    status: "running",
    createdAt: "2026-08-28T00:00:00.000Z",
    snapshot: { repository: repository.displayName, headSha: "a".repeat(40) },
    evidence: []
  };
}

let root: Root | undefined;
let onClose: ReturnType<typeof vi.fn<() => void>>;

async function renderWizard(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onClose = vi.fn<() => void>();
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en-US">
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ReviewWizardDialog repositories={[repository]} onClose={() => onClose()} />
          </QueryClientProvider>
        </MemoryRouter>
      </I18nProvider>
    );
  });
  await act(async () => { await Promise.resolve(); });
  return host;
}

function modalOf(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("[role='dialog']")!;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    candidate => candidate.textContent === text
  );
  expect(button, `expected a button labeled ${text}`).toBeTruthy();
  return button!;
}

/** Drive repository → definition → trigger and start the run. */
async function startRun(host: HTMLElement): Promise<void> {
  await act(async () => { buttonByText(host, "Next").click(); });
  const radio = host.querySelector<HTMLInputElement>("input[name='wizard-definition']")!;
  expect(radio, "expected a definition radio").toBeTruthy();
  await act(async () => { radio.click(); });
  await act(async () => { buttonByText(host, "Next").click(); });
  await act(async () => {
    buttonByText(host, "Bind and run").click();
    // Flush the mutation chain microtasks (bind → invalidate → trigger → poll).
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  });
}

function configureApi(): ReturnType<typeof vi.spyOn> {
  vi.spyOn(api, "workflowRuntimeDefinitions").mockResolvedValue([summary]);
  vi.spyOn(api, "setWorkflowRuntimeBinding").mockResolvedValue(binding);
  return vi.spyOn(api, "triggerWorkflowRuntimeForRepository").mockResolvedValue({
    runId: "run-1",
    status: "running",
    revisionId: summary.latestRevisionId!
  });
}

beforeEach(() => {
  configureApi();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ReviewWizardDialog productization", () => {
  it("stops polling and never updates again after the dialog closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runSpy = vi.spyOn(api, "workflowRuntimeRunV2").mockResolvedValue(runningRun());
    const host = await renderWizard();
    await startRun(host);
    const callsWhileMounted = runSpy.mock.calls.length;
    expect(callsWhileMounted).toBeGreaterThanOrEqual(1);
    expect(host.textContent).toContain("Run status");

    await act(async () => { root!.unmount(); });
    root = undefined;
    const callsAtClose = runSpy.mock.calls.length;

    // Two minutes of poll intervals after close: the loop must not resume.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(runSpy.mock.calls.length).toBe(callsAtClose);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("cycles Tab from the last focusable element back to the first and back", async () => {
    const host = await renderWizard();
    const modal = modalOf(host);
    const focusable = [
      ...modal.querySelectorAll<HTMLElement>(
        "input, select, textarea, button:not([disabled]), [tabindex='0']"
      )
    ].filter(el => !el.hasAttribute("disabled"));
    expect(focusable.length).toBeGreaterThanOrEqual(2);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    expect(document.activeElement).toBe(last);
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("takes focus on mount, closes on Escape, and returns focus to the trigger on close", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Start the review wizard";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const host = await renderWizard();
    const modal = modalOf(host);
    expect(document.activeElement).toBe(modal);

    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(document.activeElement).toBe(trigger);
  });
});
