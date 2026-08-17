// Temporary local config: run the API server under Node 22 for screenshot
// capture. Delete after use.
import { defineConfig } from "@playwright/test";
import captureConfig from "./playwright.capture.config";

const node22 = process.env.CONSISTENCY_NODE22_PATH ??
  "C:\\Users\\15857\\AppData\\Local\\npm-cache\\_npx\\52027bd8fc0022aa\\node_modules\\node\\bin\\node.exe";

const api = { ...captureConfig.webServer![0] };
const reuseExistingServer = process.env.CONSISTENCY_E2E_REUSE_SERVERS === "true";
const web = {
  ...captureConfig.webServer![1],
  command: `"${node22}" ../../node_modules/vite/bin/vite.js --host 127.0.0.1`,
  cwd: "apps/web",
  reuseExistingServer
};

export default defineConfig({
  ...captureConfig,
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
