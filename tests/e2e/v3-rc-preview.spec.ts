import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const outputDir = resolve(join(process.cwd(), "artifacts", "v3-rc-preview"));

const captureOnlyCss = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .page-stack { opacity: 1 !important; transform: none !important; }
`;

async function applySettings(
  page: Page,
  { width = 1440, theme = "dark", locale = "zh-CN" }: { width?: number; theme?: "dark" | "light"; locale?: "zh-CN" | "en-US" }
): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ themeSetting, localeSetting }) => {
    window.localStorage.setItem("consistency.theme.v1", themeSetting);
    window.localStorage.setItem("consistency.locale.v1", localeSetting);
    window.localStorage.setItem(
      "consistency.workbench-layout.v1",
      JSON.stringify({
        version: 1,
        explorerCollapsed: false,
        explorerWidth: 258,
        inspectorOpen: true,
        inspectorWidth: 360,
        ledgerOpen: false
      })
    );
  }, { themeSetting: theme, localeSetting: locale });
  await page.reload();
  await page.addStyleTag({ content: captureOnlyCss });
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate(() => document.fonts.ready);
}

test.describe("v3 Release Candidate Frontend Visual Preview", () => {
  test.beforeAll(() => {
    mkdirSync(outputDir, { recursive: true });
  });

  test("captures high-fidelity desktop screenshots of primary v3 UI surfaces", async ({ page, request }) => {
    // 1. Seed demo data
    const seed = await request.post("http://127.0.0.1:3001/demo/seed", { data: {} });
    expect(seed.ok()).toBe(true);

    // Get seeded job
    const jobsRes = await request.get("http://127.0.0.1:3001/jobs");
    expect(jobsRes.ok()).toBe(true);
    const { jobs } = await jobsRes.json() as { jobs: Array<{ id: string; status: string }> };
    const jobId = jobs.find(j => j.status === "succeeded")?.id ?? jobs[0]?.id;
    expect(jobId).toBeTruthy();

    // --- A. Inbox / Dashboard (zh-CN, dark) ---
    await page.goto("/#/inbox");
    await applySettings(page, { locale: "zh-CN", theme: "dark" });
    await expect(page.locator(".dashboard-page")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "01-inbox.png"), fullPage: true });

    // --- B. Run Overview (zh-CN, dark) ---
    await page.goto(`/#/runs/${encodeURIComponent(jobId!)}/overview`);
    await applySettings(page, { locale: "zh-CN", theme: "dark" });
    await expect(page.locator(".report-workspace")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "02-run-overview.png"), fullPage: true });

    // --- C. Diff Viewer (zh-CN, dark) ---
    await page.goto(`/#/runs/${encodeURIComponent(jobId!)}/diff`);
    await applySettings(page, { locale: "zh-CN", theme: "dark" });
    await expect(page.locator(".run-mode-route")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "03-diff.png"), fullPage: true });

    // --- D. Evidence (zh-CN, dark) ---
    await page.goto(`/#/runs/${encodeURIComponent(jobId!)}/evidence`);
    await applySettings(page, { locale: "zh-CN", theme: "dark" });
    await expect(page.locator(".run-evidence-mode")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "04-evidence.png"), fullPage: true });

    // --- E. Notebook (zh-CN, dark) ---
    await page.goto(`/#/runs/${encodeURIComponent(jobId!)}/notebook`);
    await applySettings(page, { locale: "zh-CN", theme: "dark" });
    await expect(page.locator(".notebook-panel")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "05-notebook.png"), fullPage: true });

    // --- F. Agent Task Manager / Runtime (zh-CN, dark) ---
    await page.goto(`/#/runs/${encodeURIComponent(jobId!)}/runtime`);
    await applySettings(page, { locale: "zh-CN", theme: "dark" });
    await expect(page.locator(".run-runtime-panel")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "06-runtime-task-manager.png"), fullPage: true });

    // --- G. Live RUNNING / WAIT_LLM Runtime (zh-CN, dark) ---
    const runningJobId = jobs.find(j => j.status === "running")?.id;
    if (runningJobId) {
      await page.goto(`/#/runs/${encodeURIComponent(runningJobId)}/runtime`);
      await applySettings(page, { locale: "zh-CN", theme: "dark" });
      await expect(page.locator(".run-runtime-panel")).toBeVisible();
      await page.screenshot({ path: join(outputDir, "07-runtime-live-wait-llm.png"), fullPage: true });
    }

    // --- H. Agent Task Manager / Runtime (zh-CN, light) ---
    await page.goto(`/#/runs/${encodeURIComponent(jobId!)}/runtime`);
    await applySettings(page, { locale: "zh-CN", theme: "light" });
    await expect(page.locator(".run-runtime-panel")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "08-runtime-light-zh.png"), fullPage: true });

    // --- I. Agent Task Manager / Runtime (en-US, dark) ---
    await applySettings(page, { locale: "en-US", theme: "dark" });
    await expect(page.locator(".run-runtime-panel")).toBeVisible();
    await page.screenshot({ path: join(outputDir, "09-runtime-dark-en.png"), fullPage: true });
  });
});
