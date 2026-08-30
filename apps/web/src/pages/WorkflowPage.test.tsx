// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRuntimeDefinitionRevision, WorkflowRuntimeDefinitionSummary } from "@consistency/schema";
import { api } from "../api/client";
import { I18nProvider, useI18n } from "../i18n";
import { WorkflowPage } from "./WorkflowPage";

const originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

vi.mock("../studio/RuntimeStudio", () => ({ RuntimeStudio: () => <div data-testid="runtime-studio-panel">Runtime Studio content</div> }));
vi.mock("../routes/WorkflowXRayView", () => ({ WorkflowXRayView: () => <div data-testid="agent-xray-panel">Pipeline Inspector content</div> }));

let root: Root | undefined;
let scrollCalls: { element: HTMLElement; options: ScrollIntoViewOptions }[];
let scrollMode: "normal" | "missing" | "throw";
let originalScrollIntoView: PropertyDescriptor | undefined;
let originalLocalStorage: PropertyDescriptor | undefined;

function LocaleToggle() {
  const { setLocale } = useI18n();
  return <button type="button" aria-label="toggle locale" onClick={() => setLocale("zh-CN")}>Switch locale</button>;
}

function SearchProbe() {
  const [searchParams] = useSearchParams();
  return <span data-testid="search-probe" data-search={searchParams.toString()} />;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true
  });
  originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: vi.fn() }
  });
  scrollCalls = [];
  scrollMode = "normal";
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement, options: ScrollIntoViewOptions) {
      if (scrollMode === "throw") throw new Error("options unsupported");
      scrollCalls.push({ element: this, options });
    }
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  if (originalLocalStorage) Object.defineProperty(window, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(window, "localStorage");
  if (originalActEnvironmentDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironmentDescriptor);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  document.body.innerHTML = "";
});

async function render(initialEntry: string, withLocaleToggle = false) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en-US">
        <MemoryRouter initialEntries={[initialEntry]}>
          <WorkflowPage />
          <SearchProbe />
          {withLocaleToggle && <LocaleToggle />}
        </MemoryRouter>
      </I18nProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

function tab(host: HTMLElement, label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(button => button.textContent?.includes(label))!;
}

describe("WorkflowPage tab visibility", () => {
  it("keeps initially selected Runtime Studio visible without focus and shows its panel", async () => {
    const host = await render("/workflows?tab=studio");
    const selected = tab(host, "Runtime Studio");

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0]?.element).toBe(selected);
    expect(scrollCalls[0]?.options).toEqual({ block: "nearest", inline: "nearest" });
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).not.toBe(selected);
    expect(host.querySelector("[data-testid=runtime-studio-panel]")).toBeTruthy();
    expect(host.querySelector("[data-testid=agent-xray-panel]")).toBeNull();
  });

  it("keeps Pipeline Inspector visible after switching and shows the new panel", async () => {
    const host = await render("/workflows?tab=studio");
    const xray = tab(host, "Pipeline Inspector");

    await act(async () => {
      xray.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(scrollCalls.at(-1)?.element).toBe(xray);
    expect(scrollCalls.at(-1)?.options).toEqual({ block: "nearest", inline: "nearest" });
    expect(xray.getAttribute("aria-selected")).toBe("true");
    expect(xray.getAttribute("role")).toBe("tab");
    expect(host.querySelector("[data-testid=agent-xray-panel]")).toBeTruthy();
    expect(host.querySelector("[data-testid=runtime-studio-panel]")).toBeNull();
  });

  it("repositions the active tab on resize and after locale text changes", async () => {
    const host = await render("/workflows?tab=studio", true);
    const selected = tab(host, "Runtime Studio");
    const initialCalls = scrollCalls.length;

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(scrollCalls.length).toBeGreaterThan(initialCalls);
    expect(scrollCalls.at(-1)?.element).toBe(selected);

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='toggle locale']")!.click();
      await Promise.resolve();
    });
    expect(scrollCalls.length).toBeGreaterThan(initialCalls + 1);
    expect(scrollCalls.at(-1)?.element).toBe(selected);
  });

  it("uses only the workflow tablist for the minimal horizontal fallback", async () => {
    scrollMode = "missing";
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    const host = await render("/workflows?tab=studio");
    const selected = tab(host, "Runtime Studio");
    const rail = host.querySelector<HTMLElement>(".workflow-sub-nav")!;
    Object.defineProperties(rail, { scrollLeft: { configurable: true, writable: true, value: 10 } });
    Object.defineProperty(selected, "scrollIntoView", { configurable: true, value: undefined });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({ left: 0, right: 200 } as DOMRect);
    vi.spyOn(selected, "getBoundingClientRect").mockReturnValue({ left: 240, right: 360 } as DOMRect);

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(rail.scrollLeft).toBe(170);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.activeElement).not.toBe(selected);
  });

  it("uses the same horizontal fallback when scrollIntoView throws", async () => {
    scrollMode = "throw";
    const host = await render("/workflows?tab=studio");
    const selected = tab(host, "Runtime Studio");
    const rail = host.querySelector<HTMLElement>(".workflow-sub-nav")!;
    Object.defineProperties(rail, { scrollLeft: { configurable: true, writable: true, value: 10 } });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({ left: 100, right: 300 } as DOMRect);
    vi.spyOn(selected, "getBoundingClientRect").mockReturnValue({ left: 40, right: 160 } as DOMRect);

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(rail.scrollLeft).toBe(-50);
  });

  it("removes the resize listener on unmount", async () => {
    const host = await render("/workflows?tab=studio");
    const selected = tab(host, "Runtime Studio");
    const callsBeforeUnmount = scrollCalls.length;
    act(() => root!.unmount());
    root = undefined;

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(scrollCalls.length).toBe(callsBeforeUnmount);
    expect(host.isConnected).toBe(true);
    expect(selected.isConnected).toBe(false);
  });
});

describe("WorkflowPage information architecture", () => {
  it("defaults to Runtime Studio when no ?tab= is present", async () => {
    const host = await render("/workflows");
    const selected = tab(host, "Runtime Studio");

    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("[data-testid=runtime-studio-panel]")).toBeTruthy();
  });

  it("orders the four tabs studio → verified runtime → triggers → pipeline inspector", async () => {
    const host = await render("/workflows");
    const labels = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].map(button => button.textContent ?? "");

    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Runtime Studio");
    expect(labels[1]).toContain("Verified runtime");
    expect(labels[2]).toContain("Triggers");
    expect(labels[3]).toContain("Pipeline Inspector");
  });

  it("redirects the removed legacy definition deep link to Runtime Studio and never renders the builder", async () => {
    const host = await render("/workflows?tab=definition");
    // The redirect runs in an effect; flush it before asserting the URL.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });

    const selected = tab(host, "Runtime Studio");
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("[data-testid=search-probe]")?.getAttribute("data-search")).toBe("tab=studio");
    // The legacy builder surface is gone: no toolbar, no builder tab badge.
    expect(host.querySelector(".workflows-toolbar")).toBeNull();
    expect(host.querySelector(".workflows-layout")).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].some(button => button.textContent?.includes("Definitions"))).toBe(false);
    expect(host.querySelector("[data-testid=runtime-studio-panel]")).toBeTruthy();
  });
});

describe("WorkflowPage verified-runtime dialog-first surface", () => {
  function mockRuntimeApi() {
    vi.spyOn(api, "workflowRuntimeOverview").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(api, "workflowRuntimeDefinitions").mockResolvedValue([]);
    vi.spyOn(api, "workflowRuntimeRuns").mockResolvedValue([]);
    vi.spyOn(api, "repositories").mockResolvedValue([]);
  }

  it("renders the management surface: definition hero, gate row, and two dialog entries", async () => {
    mockRuntimeApi();
    const host = await render("/workflows?tab=runtime");

    expect(host.querySelector(".ds-hero-title")?.textContent).toContain("No definition selected");
    expect(host.querySelector('[aria-label="Execution gates"]')).toBeTruthy();
    expect(host.querySelector(".ds-hero-actions")?.textContent).toContain("Edit definition");
    expect(host.querySelector(".ds-hero-actions")?.textContent).toContain("Configure execution");
    expect(host.querySelector('[aria-label="Workflow definition JSON"]')).toBeNull();
  });

  it("starts the gate row at validate with later actions visible but disabled", async () => {
    mockRuntimeApi();
    const host = await render("/workflows?tab=runtime");
    const gates = host.querySelector('[aria-label="Current gate actions"]')!;

    const primary = gates.querySelector<HTMLButtonElement>(".ds-button--primary")!;
    expect(primary.textContent).toContain("Validate");

    const disabled = [...gates.querySelectorAll<HTMLButtonElement>(".ds-button--secondary")];
    expect(disabled.map(button => button.textContent)).toEqual(["Save revision", "Dry-load", "Run"]);
    expect(disabled.every(button => button.disabled)).toBe(true);
  });

  it("opens the edit-definition dialog with the editor and validation affordances", async () => {
    mockRuntimeApi();
    const host = await render("/workflows?tab=runtime");
    const editButton = [...host.querySelectorAll<HTMLButtonElement>(".ds-hero-actions button")]
      .find(button => button.textContent?.includes("Edit definition"))!;

    await act(async () => {
      editButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialog = host.querySelector(".ds-dialog");
    expect(dialog?.textContent).toContain("Edit definition");
    expect(dialog?.textContent).toContain("Advanced: direct edit");
    expect(host.querySelector('[aria-label="Workflow definition JSON"]')).toBeTruthy();
    expect(host.querySelector(".ds-dialog-footer")?.textContent).toContain("Save revision");
  });

  it("opens the configure-execution dialog with the run affordance", async () => {
    mockRuntimeApi();
    const host = await render("/workflows?tab=runtime");
    const runButton = [...host.querySelectorAll<HTMLButtonElement>(".ds-hero-actions button")]
      .find(button => button.textContent?.includes("Configure execution"))!;

    await act(async () => {
      runButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialog = host.querySelector(".ds-dialog");
    expect(dialog?.textContent).toContain("Configure execution");
    expect(dialog?.textContent).toContain("Trigger binding");
    const runAction = [...(host.querySelectorAll<HTMLButtonElement>(".ds-dialog-footer button") ?? [])]
      .find(button => button.textContent?.includes("Run"))!;
    expect(runAction.disabled).toBe(true);
  });

  it("re-arms the validate gate after the draft changes following a passed validation", async () => {
    mockRuntimeApi();
    vi.spyOn(api, "validateWorkflowRuntime").mockResolvedValue({
      ok: true,
      errors: [],
      plan: {
        definitionId: "verified-mini-review",
        definitionVersion: 1 as const,
        agentSpecs: [{ nodeId: "analyze", serviceRef: "engine.style", order: 0, coeffects: [], capabilityRequirements: [], parameters: { analyzers: ["style"] } }]
      }
    });
    const host = await render("/workflows?tab=runtime");
    const editButton = [...host.querySelectorAll<HTMLButtonElement>(".ds-hero-actions button")]
      .find(button => button.textContent?.includes("Edit definition"))!;

    await act(async () => {
      editButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="Workflow definition JSON"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const type = async (value: string) => {
      await act(async () => {
        setValue.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    const draft = JSON.stringify({ id: "verified-mini-review", version: 1, nodes: [], edges: [] });

    await type(draft);
    const validateButton = [...host.querySelectorAll<HTMLButtonElement>(".ds-dialog-footer button")]
      .find(button => button.textContent?.includes("Validate"))!;
    await act(async () => {
      validateButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('.ds-chip[title="Server validation passed"]')).toBeTruthy();

    await type(`${draft} `);
    expect(host.querySelector('.ds-chip[title="Server validation passed"]')).toBeNull();
    expect(host.querySelector('.ds-chip[title="Draft changed — revalidate"]')).toBeTruthy();
    const primary = host.querySelector('[aria-label="Current gate actions"] .ds-button--primary')!;
    expect(primary.textContent).toContain("Validate");
  });
});

describe("WorkflowPage edit-definition editor loading (P1 data integrity)", () => {
  const summaries: WorkflowRuntimeDefinitionSummary[] = [
    { definitionId: "verified-mini-review", origin: "builtin", latestRevision: 1, latestRevisionId: "wfrev_mini", status: "validated", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" },
    { definitionId: "pr-review", origin: "builtin", latestRevision: 1, latestRevisionId: "wfrev_pr", status: "validated", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" }
  ];
  function revisionFixture(definitionId: string, revisionId: string): WorkflowRuntimeDefinitionRevision {
    return {
      revisionId,
      definitionId,
      revision: 1,
      status: "validated",
      definition: {
        id: definitionId,
        version: 1,
        nodes: [{ id: "analyze", type: "analyzer.deterministic-evidence", serviceRef: "deterministic-evidence.analyzer", parameters: { analyzers: ["style"] }, failurePolicy: "fail-closed" }],
        edges: []
      },
      validationIssues: [],
      createdAt: "2026-08-28T00:00:00.000Z"
    };
  }
  function editorText(host: HTMLElement): string {
    return host.querySelector<HTMLTextAreaElement>('[aria-label="Workflow definition JSON"]')!.value;
  }
  async function flush() {
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
  }

  function mockDefinitionLibrary(revisionLoader?: (definitionId: string, revisionId: string) => Promise<WorkflowRuntimeDefinitionRevision>) {
    vi.spyOn(api, "workflowRuntimeOverview").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(api, "workflowRuntimeDefinitions").mockResolvedValue(summaries);
    vi.spyOn(api, "workflowRuntimeRuns").mockResolvedValue([]);
    vi.spyOn(api, "repositories").mockResolvedValue([]);
    vi.spyOn(api, "workflowRuntimeRevision").mockImplementation(
      revisionLoader ?? (async (definitionId: string, revisionId: string) => revisionFixture(definitionId, revisionId))
    );
  }

  async function openEditor(): Promise<HTMLElement> {
    const host = await render("/workflows?tab=runtime");
    const editButton = [...host.querySelectorAll<HTMLButtonElement>(".ds-hero-actions button")]
      .find(button => button.textContent?.includes("Edit definition"))!;
    await act(async () => {
      editButton.click();
      await Promise.resolve();
    });
    await flush();
    return host;
  }

  async function chooseDefinition(host: HTMLElement, definitionId: string) {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Definition"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, definitionId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }

  it("loads the initially selected definition's own text when the dialog opens", async () => {
    mockDefinitionLibrary();
    const host = await openEditor();

    expect(host.querySelector<HTMLSelectElement>('[aria-label="Definition"]')!.value).toBe("verified-mini-review");
    expect(editorText(host).trim().length).toBeGreaterThan(0);
    expect(JSON.parse(editorText(host)).id).toBe("verified-mini-review");
  });

  it("follows selection switches with that definition's own text", async () => {
    mockDefinitionLibrary();
    const host = await openEditor();

    await chooseDefinition(host, "pr-review");

    expect(JSON.parse(editorText(host)).id).toBe("pr-review");

    await chooseDefinition(host, "verified-mini-review");

    expect(JSON.parse(editorText(host)).id).toBe("verified-mini-review");
  });

  it("resolves rapid switches by generation so a late stale response never overwrites the newest selection", async () => {
    // Every verified-mini-review load is held until the test releases it, in
    // call order, so both the "newest wins" and "stale discarded" paths run.
    const resolvers: ((revision: WorkflowRuntimeDefinitionRevision) => void)[] = [];
    mockDefinitionLibrary((_definitionId: string, revisionId: string) => {
      if (revisionId === "wfrev_mini") {
        return new Promise<WorkflowRuntimeDefinitionRevision>(resolve => { resolvers.push(resolve); });
      }
      return Promise.resolve(revisionFixture("pr-review", "wfrev_pr"));
    });
    const host = await openEditor(); // load #1: verified-mini-review, in flight

    await chooseDefinition(host, "pr-review"); // load #2 resolves immediately
    expect(JSON.parse(editorText(host)).id).toBe("pr-review");

    await chooseDefinition(host, "verified-mini-review"); // load #3: in flight

    await act(async () => {
      resolvers[1]!(revisionFixture("verified-mini-review", "wfrev_mini"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(JSON.parse(editorText(host)).id).toBe("verified-mini-review");

    await act(async () => {
      resolvers[0]!(revisionFixture("verified-mini-review", "wfrev_mini"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    // The load #1 response arrived last (after two newer selections and a newer
    // load of the same definition) and must not overwrite the editor.
    expect(JSON.parse(editorText(host)).id).toBe("verified-mini-review");
    expect(vi.mocked(api.workflowRuntimeRevision)).toHaveBeenCalledWith("verified-mini-review", "wfrev_mini");
  });
});
