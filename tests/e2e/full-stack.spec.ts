import { expect, test } from "@playwright/test";
import { createE2eLocalReview, e2eApiHeaders } from "./fixture";

test.describe("ConsistenCy Full-Stack Integration E2E Suite", () => {
  test("executes the deterministic review workbench flow without external requests", async ({ page, request }) => {
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));

    const uncaughtErrors: Error[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", error => uncaughtErrors.push(error));
    page.on("console", message => {
      const text = message.text();
      const ignoredMetaCspWarning = text.includes("frame-ancestors") && text.includes("<meta>");
      if (message.type() === "error" && !ignoredMetaCspWarning) consoleErrors.push(text);
    });
    page.on("response", response => {
      if (response.status() === 404 && !response.url().includes("/favicon.ico")) {
        consoleErrors.push(`404 ${response.url()}`);
      }
    });

    const externalRequests: string[] = [];
    page.on("request", requestItem => {
      const url = new URL(requestItem.url());
      const localHosts = new Set(["127.0.0.1:5173", "127.0.0.1:3001", "localhost:5173", "localhost:3001"]);
      if (!localHosts.has(url.host)) externalRequests.push(requestItem.url());
    });

    // 1. Verify health endpoint reports real service status
    const healthResponse = await request.get("http://127.0.0.1:3001/health", { headers: e2eApiHeaders });
    expect(healthResponse.ok()).toBe(true);
    const health = await healthResponse.json();
    expect(health.ok).toBe(true);
    expect(health.service).toBe("consistency-api");
    expect(health.worker.running).toBe(false);
    expect(health.publishWorker.running).toBe(false);
    expect(health.configuration.githubAppConfigured).toBe(false);

    // 2. Create a local review job with real Git workspace
    const { jobId } = await createE2eLocalReview(request, "full-stack-repo");
    expect(jobId).toBeTruthy();

    // 3. Open runs queue
    await page.goto("/#/runs");
    await expect(page).toHaveURL(/#\/runs$/);
    await expect(page.locator(".pw-runs-table")).toBeVisible();
    await expect(page.locator(".pw-runs-table")).toContainText("full-stack-repo");

    // 4. Open run overview
    await page.goto(`/#/runs/${encodeURIComponent(jobId)}/overview`);
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${encodeURIComponent(jobId)}\\/overview$`));
    const runModeNav = page.getByLabel(/Run views|运行视图/i);
    await expect(runModeNav.getByRole("tab", { name: /Overview|概览/i })).toHaveAttribute("aria-selected", "true");

    // 5. Open diff tab
    const diffTab = runModeNav.getByRole("tab", { name: /Diff|差异/i });
    await diffTab.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${encodeURIComponent(jobId)}\\/diff$`));
    await expect(diffTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-code-viewport, .diff-grid")).toBeVisible();

    // 6. Test language switching
    const language = () => page.getByLabel(/Language|语言/);
    if (await language().isVisible()) {
      await language().selectOption("zh-CN");
      await expect(page.locator(".location-breadcrumbs")).toBeVisible();
      await language().selectOption("en-US");
    }

    // 7. Verify zero uncaught errors
    expect(uncaughtErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
});
