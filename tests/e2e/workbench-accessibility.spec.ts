import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
    const workbench = page.locator(".audit-workbench");
    await expect(workbench).toBeVisible();
    expect((await workbench.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(640);
    await expectNoAxeViolations(page);
  });

  test("supports keyboard navigation across workbench and inspector tabs", async ({ page, request }) => {
    await request.post("http://127.0.0.1:3001/demo/seed");
    await page.goto("/#/runs");
    const firstRun = page.locator(".jobs-table tbody button").first();
    await expect(firstRun).toBeVisible();
    await firstRun.click();

    const overviewTab = page.getByRole("tab", { name: /Overview|概览/i });
    await overviewTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /Diff|差异/i })).toBeFocused();
    await expect(page).toHaveURL(/#\/runs\/[^/]+\/diff/);

    const inspectorTabs = page.locator(".inspector-tabs [role='tab']");
    if (await inspectorTabs.count()) {
      await inspectorTabs.first().focus();
      await page.keyboard.press("End");
      await expect(inspectorTabs.last()).toBeFocused();
      await expect(inspectorTabs.last()).toHaveAttribute("aria-selected", "true");
    }

    await expectNoAxeViolations(page);
  });

  test("keeps a 10k-line diff virtualized in the browser DOM", async ({ page, request }) => {
    const seeded = await request.post("http://127.0.0.1:3001/demo/seed");
    expect(seeded.ok()).toBeTruthy();
    const jobsResponse = await request.get("http://127.0.0.1:3001/jobs");
    expect(jobsResponse.ok()).toBeTruthy();
    const { jobs } = await jobsResponse.json() as { jobs: Array<{ id: string; status: string }> };
    const jobId = jobs.find(job => job.status === "succeeded")?.id;
    expect(jobId).toBeTruthy();

    await page.route(`**/api/jobs/${jobId!}/diff`, async route => {
      const content = Array.from({ length: 10_000 }, (_, index) => `+const line${index + 1} = ${index + 1};`).join("\n");
      await route.fulfill({
        json: {
          jobId: jobId!,
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

    await page.goto(`/#/runs/${jobId!}/diff`);
    await expect(page.locator(".diff-code-viewport")).toBeVisible();
    await expect(page.locator(".diff-row").first()).toBeVisible();

    const renderedRows = await page.locator(".diff-row").count();
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(250);
    const virtualHeight = await page.locator(".diff-virtual-canvas").evaluate(element => Number.parseFloat((element as HTMLElement).style.height));
    expect(virtualHeight).toBeGreaterThan(100_000);
  });
});
