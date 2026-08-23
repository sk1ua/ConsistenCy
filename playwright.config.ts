import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Playwright loads this config in more than one process, so the root must be
// identical across loads: a fixed path (or an env-pinned one) instead of a
// per-load mkdtemp, otherwise the API server and the tests would disagree on
// where the review roots and the scratch fixtures live. Clean the root at
// load; the next run cleans it again.
const e2eRoot = process.env.CONSISTENCY_E2E_ROOT ?? join(tmpdir(), "consistency-e2e");
try {
  rmSync(e2eRoot, { recursive: true, force: true });
} catch {
  // A concurrent config load may already hold files in the root (the API
  // server keeps its SQLite DB open); reusing the shared root is correct.
}
mkdirSync(e2eRoot, { recursive: true });
const databasePath = join(e2eRoot, "consistency.db");
const workspaceRoot = join(e2eRoot, "workspaces");

// The config module runs inside the test runner, so tests can read this to
// build scratch repositories inside the per-run temp root.
process.env.CONSISTENCY_E2E_ROOT = e2eRoot;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    extraHTTPHeaders: {
      Authorization: "Bearer e2e-api-token"
    }
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "node apps/api/dist/server.cjs",
      port: 3001,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120000,
      env: {
        NODE_ENV: "development",
        PORT: "3001",
        HOST: "127.0.0.1",
        LLM_PROVIDER: "deepseek",
        DATABASE_PATH: databasePath,
        CONSISTENCY_WORKSPACE_ROOT: workspaceRoot,
        CONSISTENCY_SETTINGS_ROOT: e2eRoot,
        CONSISTENCY_LOCAL_REVIEW_ROOTS: e2eRoot,
        CONSISTENCY_LOAD_ENV_FILE: "false",
        CONSISTENCY_WORKERS_ENABLED: "false",
        GITHUB_APP_ID: "",
        GITHUB_PRIVATE_KEY: "",
        GITHUB_WEBHOOK_SECRET: "",
        DEEPSEEK_API_KEY: "test-deepseek-key",
        OPENAI_API_KEY: "",
        CONSISTENCY_API_TOKEN: "e2e-api-token",
        CONSISTENCY_DESKTOP_CONTROL_TOKEN: "e2e-desktop-control-token",
        CONSISTENCY_PYTHON_PATH: process.env.CONSISTENCY_PYTHON_PATH ?? join(process.cwd(), ".venv", "Scripts", "python.exe")
      }
    },
    {
      command: "npm run dev:web",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120000,
      env: {
        CONSISTENCY_DEV_API_TARGET: "http://127.0.0.1:3001"
      }
    }
  ]
});
