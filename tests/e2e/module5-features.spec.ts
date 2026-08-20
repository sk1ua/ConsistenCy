import { expect, test } from "@playwright/test";
import { createE2eGitFixture } from "./fixture";

test.describe("Module 5 feature suite", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));
  });

  test("workflow builder lists builtins, creates a draft, and deletes it", async ({ page }) => {
    const draftName = `e2e-draft-${Date.now()}`;

    await page.goto("/#/workflows");
    await expect(page).toHaveURL(/#\/workflows$/);
    await expect(page.locator(".workflows-title")).toContainText("Workflow builder");
    await expect(page.locator(".workflow-list")).toContainText("pr-review");

    await page.locator(".workflows-toolbar").getByRole("button", { name: "New draft", exact: true }).click();
    await page.locator(".workflow-name-input").fill(draftName);
    await page.locator(".workflows-toolbar").getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.locator(".workflow-list")).toContainText(draftName);

    await page.locator(".workflow-list").getByRole("button").filter({ hasText: draftName }).click();
    await expect(page.locator(".workflow-name-input")).toHaveValue(draftName);
    await expect(page.locator(".workflow-node").first()).toBeVisible();

    await page.getByRole("button", { name: "Delete draft", exact: true }).click();
    await expect(page.locator(".workflow-list")).not.toContainText(draftName);
  });

  test("run Diff tab shows an annotated diff for a local review", async ({ page, request }) => {
    const repoPath = createE2eGitFixture("module5-diff-repo");
    const created = await request.post("http://127.0.0.1:3001/reviews/local", {
      data: { repoPath }
    });
    expect(created.ok()).toBe(true);
    const body = await created.json() as { jobId: string };
    const diffResponse = await request.get(`http://127.0.0.1:3001/jobs/${body.jobId}/diff`);
    const diff = await diffResponse.json() as { available: boolean };
    expect(diffResponse.status()).toBe(200);
    expect(diff.available).toBe(true);

    await page.goto(`/#/runs/${encodeURIComponent(body.jobId)}/overview`);
    const diffTab = page.getByLabel(/Run views|运行视图/i).getByRole("tab", { name: /Diff|差异/i, exact: true });
    await expect(diffTab).toBeVisible();
    await diffTab.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${body.jobId}\\/diff$`));
    await expect(diffTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-code-viewport, .diff-grid")).toBeVisible();
  });

  test("Inbox renders the summary and recent items in development", async ({ page }) => {
    await page.goto("/#/inbox");
    await expect(page.locator(".inbox-header-strip")).toBeVisible();
    await expect(page.locator(".inbox-title-group h2")).toHaveText(/Inbox|收件箱/);
  });
});
