import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-electron",
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]]
});
