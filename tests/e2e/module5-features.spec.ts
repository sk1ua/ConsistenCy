import { expect, test } from "@playwright/test";
import { createE2eLocalReview, e2eApiHeaders } from "./fixture";

test.describe("Module 5 feature suite", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));
  });

  test("legacy workflow builder is removed and its deep link redirects to Runtime Studio", async ({ page }) => {
    // The definition builder was deleted (Owner decision, overriding the D3
    // freeze): no builder chrome may render anywhere, and the historic
    // ?tab=definition deep link must land on the Studio tab.
    await page.goto("/#/workflows?tab=definition");
    await expect(page).toHaveURL(/#\/workflows\?tab=studio$/);
    await expect(page.getByRole("tab", { name: "Runtime Studio" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: /Definitions|工作流定义/ })).toHaveCount(0);
    await expect(page.locator(".runtime-studio")).toBeVisible();
    await expect(page.locator(".workflows-toolbar, .workflows-layout")).toHaveCount(0);
  });

  test("run Diff tab shows an annotated diff for a local review", async ({ page, request }) => {
    const { jobId } = await createE2eLocalReview(request, "module5-diff-repo");
    const diffResponse = await request.get(`http://127.0.0.1:3001/jobs/${jobId}/diff`, { headers: e2eApiHeaders });
    const diff = await diffResponse.json() as { available: boolean };
    expect(diffResponse.status()).toBe(200);
    expect(diff.available).toBe(true);

    await page.goto(`/#/runs/${encodeURIComponent(jobId)}/overview`);
    const diffTab = page.getByLabel(/Run views|运行视图/i).getByRole("tab", { name: /Diff|差异/i, exact: true });
    await expect(diffTab).toBeVisible();
    await diffTab.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${jobId}\\/diff$`));
    await expect(diffTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-code-viewport, .diff-grid")).toBeVisible();
  });

  test("Inbox renders the summary and recent items in development", async ({ page }) => {
    await page.goto("/#/inbox");
    // The Inbox header moved onto the shared ds-hero pattern (hero title plus
    // the compact summary chip line) during the style unification rework.
    await expect(page.locator(".ds-hero")).toBeVisible();
    await expect(page.locator(".ds-hero-title")).toHaveText(/Inbox|收件箱/);
    await expect(page.locator(".ds-hero .ds-chip-row")).toBeVisible();
  });
});
