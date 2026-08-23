import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createE2eLocalReview } from "./fixture";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(
    result.violations,
    result.violations.map(violation => `${violation.id}: ${violation.help}`).join("\n")
  ).toEqual([]);
}

test.describe("audit workbench accessibility", () => {
  test("keeps the shell WCAG AA-clean at desktop and compact widths", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/#/inbox");
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoAxeViolations(page);

    await page.setViewportSize({ width: 1100, height: 820 });
    await expect(page.getByRole("main")).toBeVisible();
    const workbench = page.getByRole("main");
    await expect(workbench.getByRole("heading", { name: /Inbox|收件箱/ })).toBeVisible();
    expect((await workbench.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(640);
    await expectNoAxeViolations(page);
  });

  test("supports keyboard navigation across workbench and inspector tabs", async ({ page, request }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("consistency.workbench-layout.v1", JSON.stringify({
        version: 1,
        explorerCollapsed: false,
        explorerWidth: 258,
        inspectorOpen: true,
        inspectorWidth: 360,
        ledgerOpen: false
      }));
    });
    const { jobId } = await createE2eLocalReview(request, "accessibility-tabs-repo");

    await page.goto(`/#/runs/${encodeURIComponent(jobId)}/overview`);
    const runModeNav = page.getByLabel(/Run views|运行视图/i);
    const overviewTab = runModeNav.getByRole("tab", { name: /Overview|概览/i });
    await overviewTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(runModeNav.getByRole("tab", { name: /Diff|差异/i })).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${encodeURIComponent(jobId)}\\/diff`));

    const inspectorTabs = page.locator(".inspector-tabs [role='tab']");
    if (await inspectorTabs.count()) {
      await inspectorTabs.first().focus();
      await expect(inspectorTabs.first()).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(inspectorTabs.nth(1)).toBeFocused();
    }

    await expectNoAxeViolations(page);
  });

  test("keeps a 10k-line diff virtualized in the browser DOM", async ({ page, request }) => {
    const { jobId } = await createE2eLocalReview(request, "virtual-diff-repo");

    await page.route(`**/api/jobs/${jobId}/diff`, async route => {
      const content = Array.from({ length: 10_000 }, (_, index) => `+const line${index + 1} = ${index + 1};`).join("\n");
      await route.fulfill({
        json: {
          jobId,
          available: true,
          files: [{
            path: "src/generated-large-diff.ts",
            status: "added",
            additions: 10_000,
            deletions: 0,
            binary: false,
            hunks: [{
              header: "@@ -0,0 +1,10000 @@",
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 10_000,
              content
            }]
          }]
        }
      });
    });

    await page.goto(`/#/runs/${jobId}/diff`);
    await expect(page.locator(".diff-code-viewport")).toBeVisible();
    await expect(page.locator(".diff-row").first()).toBeVisible();

    const renderedRows = await page.locator(".diff-row").count();
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(250);
    const virtualHeight = await page.locator(".diff-virtual-canvas").evaluate(element => Number.parseFloat((element as HTMLElement).style.height));
    expect(virtualHeight).toBeGreaterThan(100_000);
  });
});
