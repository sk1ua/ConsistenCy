import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);

test.describe("desktop shell", () => {
  test("boots the hardened app protocol with a healthy same-origin API", async () => {
    test.setTimeout(120_000);
    const executablePath = require("electron") as unknown as string;
    const repositoryRoot = resolve(import.meta.dirname, "..", "..");
    const userData = mkdtempSync(join(tmpdir(), "consistency-electron-smoke-"));
    const python = join(repositoryRoot, ".venv", "Scripts", "python.exe");
    const app = await electron.launch({
      args: ["apps/desktop", `--user-data-dir=${userData}`],
      executablePath,
      env: {
        ...process.env,
        CONSISTENCY_NODE_HELPER: process.execPath,
        CONSISTENCY_PYTHON_PATH: python,
        CONSISTENCY_WORKERS_ENABLED: "false",
        CONSISTENCY_HEARTBEAT_ENABLED: "false",
        DEEPSEEK_API_KEY: "test-deepseek-key-12345"
      }
    });
    try {
      await app.evaluate(({ dialog }, selectedPath) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [selectedPath] })
        });
      }, repositoryRoot);
      const window = await app.firstWindow();
      await expect(window.locator(".audit-shell")).toBeVisible({ timeout: 60_000 });
      await expect(window.getByText(/API connected|API 已连接/i)).toBeVisible();
      expect(new URL(window.url()).protocol).toBe("consistency:");

      const boundary = await window.evaluate(async () => {
        const response = await fetch("/api/health");
        const internalResponse = await fetch("/api/internal/repositories/local", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-consistency-desktop-control": "renderer-controlled"
          },
          body: JSON.stringify({ path: "renderer-must-not-register" })
        });
        const desktop = (window as typeof window & {
          consistencyDesktop?: {
            buildInfo?: () => Promise<{ version: string; commitSha: string; buildMode: string }>;
            selectRepository?: () => Promise<{
              canceled: boolean;
              repository?: { id: string };
            }>;
            updates?: { getState: () => Promise<Record<string, unknown>> };
          } & Record<string, unknown>;
        }).consistencyDesktop;
        const updates = desktop?.updates;
        const buildInfo = desktop?.buildInfo ? await desktop.buildInfo() : null;
        const selection = desktop?.selectRepository ? await desktop.selectRepository() : null;
        const repositoryId = selection?.repository?.id;
        if (!repositoryId) throw new Error("Expected the desktop host to register its local repository");

        const settingsUpdate = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            llm: {
              provider: "deepseek",
              deepseekModel: "deepseek-v4-flash",
              deepseekBaseUrl: "https://api.deepseek.com"
            }
          })
        });

        const localReview = await fetch("/api/reviews/local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repositoryId,
            baseRef: "72ff4ee",
            headRef: "HEAD"
          })
        });

        const localReviewBody = await localReview.json();
        const apiLog = await (async () => {
          try {
            const fs = (window as any).require ? (window as any).require("node:fs") : null;
            return fs ? "has-fs" : "no-fs";
          } catch { return "error"; }
        })();

        return {
          healthy: response.ok,
          internalStatus: internalResponse.status,
          settingsUpdateStatus: settingsUpdate.status,
          settingsUpdateOk: settingsUpdate.ok,
          localReviewStatus: localReview.status,
          localReviewBody,
          buildInfo,
          methods: desktop ? Object.keys(desktop).sort() : [],
          updateMethods: updates ? Object.keys(updates).sort() : [],
          updateState: updates ? await updates.getState() : null,
          hasRawUserDataPath: Boolean(desktop && "userDataPath" in desktop),
          hasRawIpc: Boolean(desktop && "ipcRenderer" in desktop)
        };
      });
      expect(boundary.healthy).toBe(true);
      expect(boundary.internalStatus).toBe(404);
      expect(boundary.settingsUpdateStatus).toBe(200);
      expect(boundary.settingsUpdateOk).toBe(true);
      expect(boundary.localReviewStatus).toBe(202);
      expect(boundary.localReviewBody).toMatchObject({
        status: "queued"
      });
      expect(boundary.buildInfo).toMatchObject({
        version: "0.1.1",
        buildMode: "development"
      });
      expect(boundary.hasRawUserDataPath).toBe(false);
      expect(boundary.hasRawIpc).toBe(false);
      expect(boundary.methods).toEqual([
        "appVersion",
        "buildInfo",
        "credentialStatus",
        "openLogsFolder",
        "restartRuntime",
        "selectRepository",
        "setCredential",
        "showFromTray",
        "updates"
      ]);
      expect(boundary.updateMethods).toEqual([
        "check",
        "download",
        "getState",
        "install",
        "onStateChange",
        "setChannel"
      ]);
      expect(boundary.updateState).toMatchObject({ mode: "manual", reason: "development", channel: "stable" });
    } finally {
      await app.close();
      const target = resolve(userData);
      const temporaryRoot = `${resolve(tmpdir())}${sep}`;
      if (!target.startsWith(temporaryRoot)) {
        throw new Error(`Refusing to remove unexpected smoke directory: ${target}`);
      }
      rmSync(target, { recursive: true, force: true });
    }
  });
});
