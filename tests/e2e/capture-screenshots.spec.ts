import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const outputDir = join(process.cwd(), "docs", "screenshots");
mkdirSync(outputDir, { recursive: true });

// 仅截图模式：禁用 animation/transition 并强制页面容器处于最终可见状态。
// 通过 addStyleTag 注入，不影响生产环境的正常 UI 动画。
const captureOnlyCss = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .page-stack { opacity: 1 !important; transform: none !important; }
`;

// 稳定等待：页面根节点与必要数据节点可见、字体就绪、根节点 opacity 为 1、
// 且不存在仍在运行的入场动画。不依赖固定 waitForTimeout。
async function stabilize(page: Page, rootSelector: string, dataSelectors: string[] = []) {
  const root = page.locator(rootSelector).first();
  await expect(root).toBeVisible();
  for (const selector of dataSelectors) {
    await expect(page.locator(selector).first()).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  await expect(root).toHaveCSS("opacity", "1");
  await page.waitForFunction(() =>
    document
      .getAnimations({ subtree: true })
      .every((animation) => animation.playState === "finished" || animation.playState === "idle")
  );
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(outputDir, name), fullPage: true });
}

test.describe("public project screenshot capture", () => {
  test.setTimeout(90_000);

  test("captures deterministic demo and available public-data views", async ({ page }) => {
    await page.goto("/");
    await page.addStyleTag({ content: captureOnlyCss });
    await expect(page.locator("h1")).toContainText(/Review overview|审查概览/i);
    await page.locator("button").filter({ hasText: /Load demo data|加载演示数据/ }).click();
    await expect(page.locator(".demo-indicator")).toBeVisible();
    await page.locator("select[aria-label='Language'], select[aria-label='语言']").selectOption("en-US");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await stabilize(page, ".page-stack.dashboard-page", [".dashboard-intro", ".metric-grid .metric-card"]);
    await capture(page, "dashboard-demo-desktop.png");

    await page.getByRole("button", { name: /Jobs|任务/ }).click();
    await expect(page.locator("h1")).toContainText(/Review queue|审查队列/i);

    const succeededJob = page.locator(".jobs-table button.table-row").filter({ hasText: /succeeded|已完成|已成功/i }).first();
    await expect(succeededJob).toBeVisible();
    await succeededJob.click();
    await stabilize(page, ".report-workspace", [".report-header", ".notebook-panel"]);
    await expect(page.locator(".notebook-source-bar")).toBeVisible();
    await capture(page, "report-demo-desktop.png");

    const notebookQuestion = page.locator("textarea[aria-label='Ask Repository Notebook']");
    await notebookQuestion.fill("Why should a reviewer inspect the selected evidence first?");
    await page.locator(".notebook-composer button[type='submit']").click();
    await expect(page.locator(".notebook-message.assistant").last()).toContainText(/evidence|证据/i, { timeout: 15_000 });
    await expect(page.locator(".notebook-citations").last()).toBeVisible();
    await page.getByRole("button", { name: "Change Map" }).click();
    await expect(page.locator(".notebook-card").first()).toBeVisible();
    await capture(page, "report-notebook-demo-desktop.png");

    await page.getByRole("button", { name: /Settings|设置/ }).click();
    await expect(page.locator("h1")).toContainText(/System status|系统状态/i);
    await stabilize(page, ".settings-editor", [".settings-group"]);
    await capture(page, "settings-demo-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /Toggle navigation|切换导航/ }).click();
    await page.getByRole("button", { name: /Dashboard|仪表盘/ }).click();
    await expect(page.locator("h1")).toContainText(/Review overview|审查概览/i);
    await stabilize(page, ".page-stack.dashboard-page", [".dashboard-intro"]);
    await capture(page, "dashboard-demo-mobile.png");

    await page.setViewportSize({ width: 1440, height: 1000 });
    // The real-data view was removed from the web UI during the local-first
    // refactor (data:import remains a CLI concern), so no real-data page is
    // captured here anymore; the archived pre-redesign screenshot stays as
    // historical reference.

    // Capture Chinese mode screenshot for CJK verification
    await page.locator("select[aria-label='Language'], select[aria-label='语言']").selectOption("zh-CN");
    await page.getByRole("button", { name: /Dashboard|仪表盘/ }).click();
    await expect(page.locator("h1")).toContainText("审查概览");
    await stabilize(page, ".page-stack.dashboard-page", [".dashboard-intro"]);
    await capture(page, "dashboard-demo-zh-desktop.png");

    // Light-theme pass for dual-theme verification (default is dark).
    await page.evaluate(() => window.localStorage.setItem("consistency.theme.v1", "light"));
    await page.reload();
    await expect(page.locator("h1")).toContainText(/Review overview|审查概览/i);
    await stabilize(page, ".page-stack.dashboard-page", [".dashboard-intro", ".metric-grid .metric-card"]);
    await capture(page, "dashboard-light-desktop.png");
    await page.getByRole("button", { name: /Settings|设置/ }).click();
    await expect(page.locator("h1")).toContainText(/System status|系统状态/i);
    await stabilize(page, ".settings-editor", [".settings-group"]);
    await capture(page, "settings-light-desktop.png");

    // Restore the dark default for the next capture run.
    await page.evaluate(() => window.localStorage.setItem("consistency.theme.v1", "dark"));
  });
});
