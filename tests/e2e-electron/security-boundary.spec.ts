import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const boundary = require(resolve(repositoryRoot, "apps", "desktop", "src", "security-boundary.cjs")) as {
  isBlockedRendererApiPath: (pathname: string) => boolean;
  isSafeExternalUrl: (url: unknown) => boolean;
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

    expect(main).toContain("CONSISTENCY_SETTINGS_WRITABLE: \"true\"");
    expect(main).toContain("CONSISTENCY_DESKTOP_CONTROL_TOKEN: desktopControlToken");
    expect(main).toContain("CONSISTENCY_API_TOKEN: apiToken");
    expect(main).not.toContain('CONSISTENCY_API_TOKEN: DEV_URL ? "" : apiToken');
    expect(main).toContain('apiFetch("/internal/repositories/local"');
    expect(main).toContain("[DESKTOP_CONTROL_HEADER]: desktopControlToken");
    expect(main).toContain("headers.delete(DESKTOP_CONTROL_HEADER)");
    expect(main).toContain("isBlockedRendererApiPath(url.pathname)");
    expect(main.match(/randomBytes\(32\)\.toString\("base64url"\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(main).toContain('ipcMain.handle("runtime:restart"');
    expect(main).toContain('ipcMain.handle("app:build-info"');
    expect(main).toContain("async function restartApi()");
    expect(main).toContain("function stopChildProcess(");
    expect(main).toContain("if (child !== apiProcess || quitting || intentionalExit || restarting) return;");
    expect(preload).toContain('appVersion: () => ipcRenderer.invoke("app:version")');
    expect(preload).toContain('buildInfo: () => ipcRenderer.invoke("app:build-info")');
    expect(preload).toContain('selectRepository: () => ipcRenderer.invoke("repositories:select")');
    expect(preload).toContain('restartRuntime: () => ipcRenderer.invoke("runtime:restart")');
    expect(preload).not.toContain("desktopControlToken");
    expect(preload).not.toContain("apiToken");
    expect(preload).not.toContain("apiPort");
    expect(preload).not.toContain("x-consistency-desktop-control");
  });

  test("wires the logs folder as a semantic main-only action with no renderer path authority", () => {
    const main = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "main.cjs"), "utf8");
    const preload = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "preload.cjs"), "utf8");

    // The handler shape is pinned verbatim: zero renderer arguments, the
    // trusted-sender guard, and a main-side helper call only.
    expect(main).toContain(
      'ipcMain.handle("logs:open", async event => {\n' +
      '    assertTrustedSender(event);\n' +
      '    return openLogsFolder();\n' +
      '  });'
    );
    expect(main).toContain("async function openLogsFolder()");
    // The path is resolved exclusively in main from userData.
    expect(main).toContain('app.getPath("userData")');
    expect(main).toContain('shell.openPath(userData)');
    // Only a boolean crosses the bridge; the shell error description (which
    // may embed local paths) is never forwarded.
    expect(main).toContain('return { ok: result === "" };');
    const logsHelper = main.match(/async function openLogsFolder\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(logsHelper).toBeDefined();
    expect(logsHelper).not.toMatch(/\berror\b/);

    // Preload surface: the method takes no parameters by construction and
    // never opens paths renderer-side.
    expect(preload).toContain('openLogsFolder: () => ipcRenderer.invoke("logs:open")');
    expect(preload).not.toMatch(/openLogsFolder:\s*\([^)]/);
    expect(preload).not.toContain("shell.openPath");
    expect(preload).not.toMatch(/openPath\s*\(/);
  });

  test("validates external URLs allowing only safe HTTPS and denying unsafe schemes", () => {
    expect(boundary.isSafeExternalUrl("https://platform.openai.com/api-keys")).toBe(true);
    expect(boundary.isSafeExternalUrl("https://api-docs.deepseek.com/api/deepseek-api")).toBe(true);
    expect(boundary.isSafeExternalUrl("https://docs.github.com/en/apps/creating-github-apps")).toBe(true);
    expect(boundary.isSafeExternalUrl("https://github.com/sk1ua/ConsistenCy")).toBe(true);

    expect(boundary.isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(boundary.isSafeExternalUrl("file:///C:/passwords.txt")).toBe(false);
    expect(boundary.isSafeExternalUrl("data:text/html,<h1>evil</h1>")).toBe(false);
    expect(boundary.isSafeExternalUrl("http://platform.openai.com/api-keys")).toBe(false);
    expect(boundary.isSafeExternalUrl("vbscript:msgbox")).toBe(false);
    expect(boundary.isSafeExternalUrl("custom-protocol://test")).toBe(false);
    expect(boundary.isSafeExternalUrl("")).toBe(false);
    expect(boundary.isSafeExternalUrl(undefined)).toBe(false);
  });

  test("wires secure external navigation using setWindowOpenHandler and will-navigate", () => {
    const main = readFileSync(resolve(repositoryRoot, "apps", "desktop", "src", "main.cjs"), "utf8");

    const windowOpenHandler = main.match(
      /window\.webContents\.setWindowOpenHandler\(details => \{([\s\S]*?)\n\s*\}\);/
    )?.[1];
    expect(windowOpenHandler).toBeDefined();
    expect(windowOpenHandler).toContain("isSafeExternalUrl(details.url)");
    expect(windowOpenHandler).toContain("shell.openExternal(details.url)");
    expect(windowOpenHandler).toContain('return { action: "deny" };');
    expect(windowOpenHandler).not.toContain('return { action: "allow" };');

    const navigationHandler = main.match(
      /window\.webContents\.on\("will-navigate", \(event, url\) => \{([\s\S]*?)\n\s*\}\);/
    )?.[1];
    expect(navigationHandler).toBeDefined();
    expect(navigationHandler).toContain("isTrustedRendererUrl(url)");
    expect(navigationHandler).toContain("event.preventDefault()");
    expect(navigationHandler).toContain("isSafeExternalUrl(url)");
    expect(navigationHandler).toContain("shell.openExternal(url)");
    expect(navigationHandler).not.toContain('return { action: "allow" };');

    const unsafeUrls: readonly unknown[] = [
      "http://github.com/org/repo/pull/1",
      "javascript:alert(1)",
      "file:///C:/passwords.txt",
      "data:text/html,<h1>evil</h1>",
      "not-a-url",
      undefined
    ];
    for (const url of unsafeUrls) {
      expect(boundary.isSafeExternalUrl(url), String(url)).toBe(false);
    }
    expect(boundary.isSafeExternalUrl("https://github.com/org/repo/pull/1")).toBe(true);
  });

  test("rejects an absolute path smuggled into the public display name", () => {
    const selectedPath = resolve(repositoryRoot, "private-fixture", "audit-repo");
    expect(() => boundary.toRendererSafeRepository({
      ...publicRepository,
      displayName: selectedPath
    })).toThrow(/local path/i);
  });

  test("verifies desktop pack enforces clean tree and resolves dynamic git commit", () => {
    const packScript = readFileSync(resolve(repositoryRoot, "scripts", "desktop-pack.mjs"), "utf8");
    expect(packScript).toContain('spawnSync("git", ["status", "--porcelain"]');
    expect(packScript).toContain("clean Git working tree");
    expect(packScript).toContain('spawnSync("git", ["rev-parse", "HEAD"]');
    expect(packScript).toContain("apiDistModules");
  });
});
