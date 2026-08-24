import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Repository } from "@consistency/schema";
import { ApiRequestError } from "../api/client";
import { I18nProvider } from "../i18n";
import { RepositoriesPage } from "./RepositoriesPage";

// @vitest-environment happy-dom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connectedRepository: Repository = {
  id: "repo_connected",
  displayName: "codex",
  source: "github",
  remoteFullName: "openai/codex",
  defaultBranch: "main",
  trustLevel: "untrusted_readonly",
  monitoringEnabled: false,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness({ connect }: { connect: (input: string) => Promise<Repository> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <I18nProvider initialLocale="en-US">
      <MemoryRouter>
        <RepositoriesPage
          jobs={[]}
          pulse={null}
          heartbeatUnavailable={false}
          jobsUnavailable={false}
          connectingPublicRepository={pending}
          publicRepositoryError={error}
          onConnectPublicRepository={async input => {
            setPending(true);
            setError(undefined);
            try {
              return await connect(input);
            } catch (connectError) {
              setError(connectError);
              throw connectError;
            } finally {
              setPending(false);
            }
          }}
        />
      </MemoryRouter>
    </I18nProvider>
  );
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function mount(connect: (input: string) => Promise<Repository>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(<Harness connect={connect} />); });
  const openButton = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Connect repository"));
  await act(async () => { openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  return { container, root };
}

describe("RepositoriesPage public connection", () => {
  it("submits owner/repository, shows a disabled loading state, and closes only after real success", async () => {
    const pending = deferred<Repository>();
    let submitted = "";
    const { container, root } = await mount(input => {
      submitted = input;
      return pending.promise;
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Public GitHub repository URL"]')!;
    await act(async () => {
      setInputValue(input, "openai/codex");
    });
    const form = input.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(submitted).toBe("openai/codex");
    expect(container.textContent).toContain("Connecting");
    expect(input.disabled).toBe(true);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => { pending.resolve(connectedRepository); await pending.promise; });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("keeps the form open and renders a typed private/authentication error", async () => {
    const { container, root } = await mount(async () => {
      throw new ApiRequestError("provider detail", "PUBLIC_REPOSITORY_AUTH_REQUIRED", 403);
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Public GitHub repository URL"]')!;
    await act(async () => {
      setInputValue(input, "https://github.com/acme/private");
    });
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("private or requires GitHub authentication");
    expect(container.textContent).not.toContain("provider detail");
    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});
