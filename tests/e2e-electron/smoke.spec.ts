import { createRequire } from "node:module";
import { _electron as electron, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);

test.describe("desktop shell", () => {
  test("boots the web UI with a healthy API", async () => {
    test.setTimeout(120_000);
    const executablePath = require("electron") as unknown as string;
    const app = await electron.launch({ args: ["apps/desktop"], executablePath });
    try {
      const window = await app.firstWindow();
      await expect(window.locator(".app-sidebar")).toBeVisible({ timeout: 60_000 });
      await expect(window.getByRole("heading", { level: 1 })).toContainText(/Review overview|审查概览/i);
      const healthy = await window.evaluate(async () => {
        const response = await fetch("http://127.0.0.1:3001/health");
        return response.ok;
      });
      expect(healthy).toBe(true);
    } finally {
      await app.close();
    }
  });
});
