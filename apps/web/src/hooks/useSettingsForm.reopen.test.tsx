/**
 * Atomic SettingsDialog reopen lifecycle test for CKPT4 Phase 1.2.
 *
 * The harness conditionally mounts the real SettingsDialog exactly as AppShell
 * mounts it. Deferred settings requests prove a fresh reopen renders loading
 * before persisted settings resolve, never a stale unsaved draft.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "../api/client";
import { api } from "../api/client";
import { I18nProvider } from "../i18n";
import { SettingsDialog } from "../components/SettingsDialog";

// @vitest-environment happy-dom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSettings(provider: "deepseek" | "openai", model: string): SettingsSnapshot {
  return {
    llm: {
      provider,
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekModel: provider === "deepseek" ? model : "",
      openaiModel: provider === "openai" ? model : "",
      deepseekApiKeyConfigured: true,
      openaiApiKeyConfigured: false
    },
    github: {
      appId: "",
      privateKeyConfigured: false,
      webhookSecretConfigured: false,
      publicReadTokenConfigured: false
    },
    runtime: {
      storage: { kind: "file", configured: true },
      workspace: { configured: true },
      localReview: { configured: false, rootCount: 0 },
      workerConcurrency: 1,
      workerPollIntervalMs: 500,
      webUrl: "http://127.0.0.1:5173",
      apiTokenConfigured: false
    },
    overriddenByEnvironment: [],
    restartRequired: false
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function MountedSettingsDialog({ onUnmount }: { onUnmount: () => void }) {
  useEffect(() => () => onUnmount(), [onUnmount]);
  return <SettingsDialog isOpen onClose={() => undefined} />;
}

function Harness({ isOpen, onUnmount }: { isOpen: boolean; onUnmount: () => void }) {
  return (
    <I18nProvider initialLocale="en-US">
      {isOpen && <MountedSettingsDialog onUnmount={onUnmount} />}
    </I18nProvider>
  );
}

describe("SettingsDialog atomic reopen lifecycle (Phase 1.2)", () => {
  it("unmounts on close and blocks stale draft before the fresh persisted reload resolves", async () => {
    const persistedA = makeSettings("deepseek", "persisted-A");
    const persistedC = makeSettings("openai", "persisted-C");
    const firstFetch = deferred<SettingsSnapshot>();
    const secondFetch = deferred<SettingsSnapshot>();
    let fetchCount = 0;
    const settingsSpy = vi.spyOn(api, "settings").mockImplementation(() => {
      fetchCount += 1;
      return fetchCount === 1 ? firstFetch.promise : secondFetch.promise;
    });
    let unmountCount = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(<Harness isOpen onUnmount={() => { unmountCount += 1; }} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Loading configuration");
    expect(container.textContent).not.toContain("persisted-A");

    await act(async () => {
      firstFetch.resolve(persistedA);
      await firstFetch.promise;
    });
    const modelInput = () => container.querySelector<HTMLInputElement>("#setting-deepseek-model");
    expect(modelInput()?.value).toBe("persisted-A");

    await act(async () => {
      const input = modelInput()!;
      input.value = "unsaved-B";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modelInput()?.value).toBe("unsaved-B");

    await act(async () => {
      root.render(<Harness isOpen={false} onUnmount={() => { unmountCount += 1; }} />);
    });
    expect(unmountCount).toBe(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      root.render(<Harness isOpen onUnmount={() => { unmountCount += 1; }} />);
      await Promise.resolve();
    });
    expect(fetchCount).toBe(2);
    expect(container.textContent).toContain("Loading configuration");
    expect(container.textContent).not.toContain("unsaved-B");
    expect(modelInput()).toBeNull();

    await act(async () => {
      secondFetch.resolve(persistedC);
      await secondFetch.promise;
    });
    expect(container.querySelector<HTMLInputElement>("#setting-openai-model")?.value).toBe("persisted-C");
    expect(container.textContent).not.toContain("unsaved-B");

    await act(async () => {
      root.unmount();
    });
    settingsSpy.mockRestore();
    document.body.removeChild(container);
  });
});
