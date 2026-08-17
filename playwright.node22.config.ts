// Temporary local config: run the API server under Node 22 (the project
// baseline, matching the better-sqlite3 ABI) instead of whatever Node is on
// PATH. Delete this file after the e2e run.
import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

const node22 = process.env.CONSISTENCY_NODE22_PATH ??
  "C:\\Users\\15857\\AppData\\Local\\npm-cache\\_npx\\52027bd8fc0022aa\\node_modules\\node\\bin\\node.exe";

const api = { ...baseConfig.webServer![0] };
const reuseExistingServer = process.env.CONSISTENCY_E2E_REUSE_SERVERS === "true";
const web = {
  ...baseConfig.webServer![1],
  command: `"${node22}" ../../node_modules/vite/bin/vite.js --host 127.0.0.1`,
  cwd: "apps/web",
  reuseExistingServer
};

export default defineConfig({
  ...baseConfig,
  webServer: [
    {
      ...api,
      command: `"${node22}" dist/server.cjs`,
      cwd: "apps/api",
      reuseExistingServer,
      env: {
        ...api.env,
        CONSISTENCY_PYTHON_PATH:
          "D:\\sk1ua\\python\\ConsistenCy\\.venv\\Scripts\\python.exe"
      }
    },
    web
  ]
});
