import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const boundary = require(resolve(repositoryRoot, "apps", "desktop", "src", "security-boundary.cjs")) as {
  isBlockedRendererApiPath: (pathname: string) => boolean;
  selectAndRegisterRepository: (options: {
    showOpenDialog: (_parent: unknown, options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>;
    parentWindow: unknown;
    registerRepository: (input: { displayName: string; path: string; monitoringEnabled: boolean }) => Promise<unknown>;
  }) => Promise<unknown>;
  toRendererSafeRepository: (input: unknown) => Record<string, unknown>;
};

const publicRepository = {
  id: "repo_local_fixture",
  displayName: "audit-repo",
  source: "local_git",
  trustLevel: "untrusted_readonly",
  monitoringEnabled: true,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z"
};

test.describe("desktop repository security boundary", () => {
  test("blocks internal routes including encoded and normalized variants", () => {
    for (const pathname of [
      "/api/internal",
      "/api/internal/repositories/local",
      "/api/%69nternal/repositories/local",
      "/api/%2569nternal/repositories/local",
      "/api/public/../internal/repositories/local",
      "/api/%2e%2e%2finternal/repositories/local",
      "/api\\internal\\repositories\\local",
      "/api/%"
    ]) {
      expect(boundary.isBlockedRendererApiPath(pathname), pathname).toBe(true);
    }
    expect(boundary.isBlockedRendererApiPath("/api/repositories")).toBe(false);
    expect(boundary.isBlockedRendererApiPath("/api/internality")).toBe(false);
  });

  test("keeps the selected path in main and returns a field-whitelisted Repository", async () => {
    const selectedPath = resolve(repositoryRoot, "private-fixture", "audit-repo");
    let registrationInput: { displayName: string; path: string; monitoringEnabled: boolean } | undefined;
    const result = await boundary.selectAndRegisterRepository({
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
      parentWindow: {},
      registerRepository: async input => {
        registrationInput = input;
        return {
          repository: {
            ...publicRepository,
            path: selectedPath,
            repoPath: selectedPath,
            controlToken: "renderer-must-not-see-this",
            port: 8787
          }
        };
      }
    });

    expect(registrationInput).toEqual({
      displayName: "audit-repo",
      path: selectedPath,
      monitoringEnabled: true
    });
    expect(result).toEqual({ canceled: false, repository: publicRepository });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(selectedPath);
    expect(serialized).not.toContain("renderer-must-not-see-this");
    expect(serialized).not.toContain("8787");
  });

  test("returns only a stable sanitized message when registration fails", async () => {
    const selectedPath = resolve(repositoryRoot, "private-fixture", "audit-repo");
    const result = await boundary.selectAndRegisterRepository({
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
      parentWindow: {},
      registerRepository: async () => {
        throw new Error(`helper leaked ${selectedPath} token=secret port=8787`);
      }
    });

    expect(result).toEqual({
      canceled: false,
      error: "The repository could not be registered. Try again."
    });
    expect(JSON.stringify(result)).not.toContain(selectedPath);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("8787");
  });

  test("wires an independent main-only control capability", () => {
    const main = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "main.cjs"), "utf8");
    const preload = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "preload.cjs"), "utf8");

    expect(main).toContain("CONSISTENCY_DESKTOP_CONTROL_TOKEN: desktopControlToken");
    expect(main).toContain("CONSISTENCY_API_TOKEN: apiToken");
    expect(main).not.toContain('CONSISTENCY_API_TOKEN: DEV_URL ? "" : apiToken');
    expect(main).toContain('apiFetch("/internal/repositories/local"');
    expect(main).toContain("[DESKTOP_CONTROL_HEADER]: desktopControlToken");
    expect(main).toContain("headers.delete(DESKTOP_CONTROL_HEADER)");
    expect(main).toContain("isBlockedRendererApiPath(url.pathname)");
    expect(main.match(/randomBytes\(32\)\.toString\("base64url"\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(preload).toContain('selectRepository: () => ipcRenderer.invoke("repositories:select")');
    expect(preload).not.toContain("desktopControlToken");
    expect(preload).not.toContain("apiToken");
    expect(preload).not.toContain("apiPort");
    expect(preload).not.toContain("x-consistency-desktop-control");
  });

  test("rejects an absolute path smuggled into the public display name", () => {
    const selectedPath = resolve(repositoryRoot, "private-fixture", "audit-repo");
    expect(() => boundary.toRendererSafeRepository({
      ...publicRepository,
      displayName: selectedPath
    })).toThrow(/local path/i);
  });
});
