import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Analysis workspaces hold clones of other repositories; never discover
    // their test files as our own.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.consistency/**"]
  }
});
