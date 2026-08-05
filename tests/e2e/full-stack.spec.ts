import { expect, test } from "@playwright/test";

test.describe("ConsistenCy Full-Stack Integration E2E Suite", () => {
  test("executes deterministic E2E flow: seeds demo, asserts workers are disabled, verifies reports and badges without external requests", async ({ page, request }) => {
    // 1. Error tracking & Host Isolation
    const uncaughtErrors: Error[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => uncaughtErrors.push(error));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    const externalRequests: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.host !== "127.0.0.1:5173" && url.host !== "127.0.0.1:3001" && url.host !== "localhost:5173" && url.host !== "localhost:3001") {
        externalRequests.push(req.url());
      }
    });

    // 2. Direct API Health Check (asserting workers are disabled and GitHub App is not configured)
    const healthRes = await request.get("http://127.0.0.1:3001/health");
    expect(healthRes.ok()).toBe(true);
    const healthData = await healthRes.json();
    expect(healthData.ok).toBe(true);
    expect(healthData.service).toBe("consistency-api");
    expect(healthData.worker.running).toBe(false);
    expect(healthData.publishWorker.running).toBe(false);
    expect(healthData.configuration.githubAppConfigured).toBe(false);
    expect(healthData.configuration.demoMode).toBe(true);

    // 3. Open Web Application
    await page.goto("http://127.0.0.1:5173");
    await expect(page.locator("h1")).toContainText(/Review overview|审查概览/i);

    // 4. Seed Demo Data Deterministically (asserting 201 Created response)
    const loadDemoButton = page.locator("button:has-text('Load demo data'), button:has-text('加载演示数据')");
    await expect(loadDemoButton).toBeVisible();

    const responsePromise = page.waitForResponse((res) => res.url().includes("/demo/seed") && res.status() === 201);
    await loadDemoButton.click();
    const seedResponse = await responsePromise;
    expect(seedResponse.status()).toBe(201);

    // 5. Verify queued demo job stays queued (workers disabled)
    await page.waitForTimeout(1200);
    const jobsRes = await request.get("http://127.0.0.1:3001/jobs");
    expect(jobsRes.ok()).toBe(true);
    const jobsData = await jobsRes.json();
    const queuedJob = jobsData.jobs.find((j: { status: string }) => j.status === "queued");
    expect(queuedJob).toBeDefined();

    // 6. Navigate to Jobs Queue & Assert Seeded Jobs
    await page.click("button:has-text('Jobs'), button:has-text('任务')");
    await expect(page.locator("h1")).toContainText(/Review queue|审查队列/i);

    const jobRows = page.locator(".jobs-table button.table-row");
    await expect(jobRows.first()).toBeVisible();

    // 7. Open Report Page & Assert Summary, Risk Score, Findings, and Agent Timeline
    const succeededJobRow = page.locator(".jobs-table button.table-row:has-text('Succeeded'), .jobs-table button.table-row:has-text('已完成')").first();
    await expect(succeededJobRow).toBeVisible();
    await succeededJobRow.click();

    await expect(page.locator(".report-page")).toBeVisible();
    await expect(page.locator("h1")).toContainText(/Review report|审查报告/i);
    await expect(page.locator(".report-header p")).not.toHaveText("");
    const reviewReportTab = page.getByRole("button", { name: "Review report", exact: true });
    if (await reviewReportTab.count()) {
      await expect(page.getByRole("button", { name: "Notebook workspace", exact: true })).toHaveAttribute("aria-pressed", "true");
      await reviewReportTab.click();
    }
    await expect(page.locator(".report-score")).toBeVisible();
    await expect(page.locator(".report-score")).toContainText(/Significant Drift|Slight Drift|Minimal Drift|Critical|High|Medium|Low|None|分|层级/i);
    await expect(page.locator(".finding-item").first()).toBeVisible();
    await expect(page.locator(".agent-timeline")).toBeVisible();
    await expect(page.locator(".agent-run").first()).toBeVisible();

    // 8. Test Language Switcher and Status Badge Translations (Chinese & English)
    const selectLang = () => page.locator("select[aria-label='Language'], select[aria-label='语言']");
    await selectLang().selectOption("zh-CN");
    await expect(page.locator("h1")).toContainText("审查报告");

    await page.click("button:has-text('返回任务列表'), button:has-text('Back to jobs')");
    await expect(page.locator("h1")).toContainText("审查队列");
    await expect(page.locator(".badge").filter({ hasText: /已完成|已成功|排队中|运行中|失败/i }).first()).toBeVisible();

    await selectLang().selectOption("en-US");
    await expect(page.locator("h1")).toContainText("Review queue");
    await expect(page.locator(".badge").filter({ hasText: /succeeded|queued|running|failed/i }).first()).toBeVisible();

    // 9. Assert zero uncaught page errors and zero external network requests
    expect(uncaughtErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
});
