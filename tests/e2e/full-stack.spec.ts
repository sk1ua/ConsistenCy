import { expect, test } from "@playwright/test";

test.describe("ConsistenCy Full-Stack Integration E2E Suite", () => {
  test("executes the deterministic audit-workbench flow without external requests", async ({ page, request }) => {
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
      if (response.status() === 404) consoleErrors.push(`404 ${response.url()}`);
    });

    const externalRequests: string[] = [];
    page.on("request", requestItem => {
      const url = new URL(requestItem.url());
      const localHosts = new Set(["127.0.0.1:5173", "127.0.0.1:3001", "localhost:5173", "localhost:3001"]);
      if (!localHosts.has(url.host)) externalRequests.push(requestItem.url());
    });

    const healthResponse = await request.get("http://127.0.0.1:3001/health");
    expect(healthResponse.ok()).toBe(true);
    const health = await healthResponse.json();
    expect(health.ok).toBe(true);
    expect(health.service).toBe("consistency-api");
    expect(health.worker.running).toBe(false);
    expect(health.publishWorker.running).toBe(false);
    expect(health.configuration.githubAppConfigured).toBe(false);
    expect(health.configuration.demoMode).toBe(true);

    await page.goto("/#/inbox");
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review inbox");

    const loadDemoButton = page.getByRole("button", { name: "Load demo data", exact: true });
    await expect(loadDemoButton).toBeVisible();
    const seedResponsePromise = page.waitForResponse(response => response.url().includes("/api/demo/seed") && response.status() === 201);
    await loadDemoButton.click();
    expect((await seedResponsePromise).status()).toBe(201);

    await page.waitForTimeout(1_200);
    const jobsResponse = await request.get("http://127.0.0.1:3001/jobs");
    expect(jobsResponse.ok()).toBe(true);
    const jobsPayload = await jobsResponse.json() as { jobs: Array<{ status: string }> };
    expect(jobsPayload.jobs.some(job => job.status === "queued")).toBe(true);

    await page.locator(".activity-rail").getByRole("link", { name: "Runs", exact: true }).click();
    await expect(page).toHaveURL(/#\/runs$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audit runs");

    const runsTable = page.getByRole("table", { name: "Review queue" });
    await expect(runsTable).toBeVisible();
    const succeededRow = runsTable.getByRole("row").filter({ hasText: /Succeeded/i }).first();
    await expect(succeededRow).toBeVisible();
    await succeededRow.getByRole("button").click();

    await expect(page).toHaveURL(/#\/runs\/[^/]+\/overview/);
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".report-page")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run workbench");
    await expect(page.locator(".report-header p")).not.toHaveText("");
    await expect(page.locator(".report-score")).toBeVisible();
    await expect(page.locator(".report-score")).toContainText(/Significant Drift|Slight Drift|Minimal Drift|Critical|High|Medium|Low|None/i);
    await expect(page.locator(".finding-item").first()).toBeVisible();
    const agentRunsTab = page.locator(".report-detail-tabs").getByRole("tab", { name: "Agent runs", exact: true });
    await agentRunsTab.click();
    await expect(agentRunsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".agent-timeline")).toBeVisible();
    await expect(page.locator(".agent-run").first()).toBeVisible();

    const language = () => page.getByLabel(/Language|语言/);
    await language().selectOption("zh-CN");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("运行工作台");

    await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
    await expect(page).toHaveURL(/#\/runs$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("审计运行");
    await expect(page.locator(".badge").filter({ hasText: /已成功|排队中|运行中|失败/ }).first()).toBeVisible();

    await language().selectOption("en-US");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audit runs");
    await expect(page.locator(".badge").filter({ hasText: /succeeded|queued|running|failed/i }).first()).toBeVisible();

    expect(uncaughtErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
});
