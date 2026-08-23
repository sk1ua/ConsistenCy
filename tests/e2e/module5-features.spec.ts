import { expect, test } from "@playwright/test";
import { createE2eLocalReview, e2eApiHeaders } from "./fixture";

test.describe("Module 5 feature suite", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));
  });

  test("workflow builder lists builtins, creates a draft, and deletes it", async ({ page }) => {
    const draftName = `e2e-draft-${Date.now()}`;

    await page.goto("/#/workflows");
    await expect(page).toHaveURL(/#\/workflows$/);
    await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
    const workflows = page.getByRole("complementary", { name: "Workflows", exact: true });
    await expect(workflows.getByRole("button", { name: /pr-review/ })).toBeVisible();

    await page.locator(".workflows-toolbar").getByRole("button", { name: "New draft", exact: true }).click();
    await page.locator(".workflow-name-input").fill(draftName);
    await page.locator(".workflows-toolbar").getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(workflows.getByRole("button", { name: new RegExp(draftName) })).toBeVisible();

    await workflows.getByRole("button", { name: new RegExp(draftName) }).click();
    await expect(page.locator(".workflow-name-input")).toHaveValue(draftName);
    await expect(page.locator(".workflow-node").first()).toBeVisible();

    await page.getByRole("button", { name: "Delete draft", exact: true }).click();
    await expect(workflows.getByRole("button", { name: new RegExp(draftName) })).toHaveCount(0);
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
    await expect(page.locator(".inbox-header-strip")).toBeVisible();
    await expect(page.locator(".inbox-title-group h2")).toHaveText(/Inbox|收件箱/);
  });
});
