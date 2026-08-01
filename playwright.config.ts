import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const e2eRoot = mkdtempSync(join(tmpdir(), "consistency-e2e-"));
const databasePath = join(e2eRoot, "consistency.db");
const workspaceRoot = join(e2eRoot, "workspaces");

process.once("exit", () => {
  rmSync(e2eRoot, { recursive: true, force: true });
});

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: /capture-screenshots\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "npm run dev:api",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "development",
        PORT: "3001",
        HOST: "127.0.0.1",
        LLM_PROVIDER: "mock",
        DATABASE_PATH: databasePath,
        CONSISTENCY_WORKSPACE_ROOT: workspaceRoot,
        CONSISTENCY_SETTINGS_ROOT: e2eRoot,
        CONSISTENCY_LOAD_ENV_FILE: "false",
        CONSISTENCY_WORKERS_ENABLED: "false",
        GITHUB_APP_ID: "",
        GITHUB_PRIVATE_KEY: "",
        GITHUB_WEBHOOK_SECRET: "",
        DEEPSEEK_API_KEY: "",
        OPENAI_API_KEY: "",
        CONSISTENCY_API_TOKEN: "",
        CONSISTENCY_PYTHON_PATH: process.env.CONSISTENCY_PYTHON_PATH ?? "python"
      }
    },
    {
      command: "npm run dev:web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        VITE_API_BASE_URL: "http://127.0.0.1:3001"
      }
    }
  ]
});
