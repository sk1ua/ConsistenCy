import { expect, test } from "@playwright/test";

test.describe("Module 5 feature suite", () => {
  test("workflow builder lists builtins, opens a draft, and deletes it", async ({ page, request }) => {
    const draftName = `e2e-draft-${Date.now()}`;
    const spec = {
      version: 2,
      name: draftName,
      description: "E2E draft workflow",
      nodes: [{ id: "security", uses: "engine.security", timeoutMs: 120000 }],
      verifiers: [],
      synthesizer: { needs: ["security"], timeoutMs: 120000 }
    };
    const saved = await request.put(`http://127.0.0.1:3001/workflows/${draftName}`, { data: spec });
    expect(saved.ok()).toBe(true);

    await page.goto("http://127.0.0.1:5173/?view=workflows");
    await expect(page.locator("h1")).toContainText(/Workflow builder|工作流构建器/i);
    await expect(page.locator(".workflow-list")).toContainText("pr-review");
    await expect(page.locator(".workflow-list")).toContainText(draftName);

    await page.click(`.workflow-list button:has-text("${draftName}")`);
    await expect(page.locator(".workflow-name-input")).toHaveValue(draftName);
    await expect(page.locator(".workflow-node")).toHaveCount(2);

    await page.click("button:has-text('Delete draft'), button:has-text('删除草稿')");
    await expect(page.locator(".workflow-list")).not.toContainText(draftName);
  });

  test("report page shows an annotated diff for a local review job", async ({ page, request }) => {
    const created = await request.post("http://127.0.0.1:3001/reviews/local", {
      data: { repoPath: process.cwd() }
    });
    expect(created.ok()).toBe(true);
    const body = await created.json();
    const diffRes = await request.get(`http://127.0.0.1:3001/jobs/${body.jobId}/diff`);
    const diffBody = await diffRes.json();
    expect(diffRes.status()).toBe(200);
    expect(diffBody.available).toBe(true);

    await page.goto(`http://127.0.0.1:5173/?view=report&job=${body.jobId}`);
    const diffTab = page.locator(".workspace-mode-tabs button:has-text('Diff'), .workspace-mode-tabs button:has-text('差异')");
    await expect(diffTab).toBeVisible();
    await diffTab.click();
    await expect(page.locator(".diff-file-list")).toBeVisible();
    await expect(page.locator(".diff-file-list button").first()).toBeVisible();
    await expect(page.locator(".diff-grid .diff-row").first()).toBeVisible();
  });

  test("dashboard renders the live heartbeat card in development", async ({ page }) => {
    await page.goto("http://127.0.0.1:5173");
    await expect(page.locator(".heartbeat-card")).toBeVisible();
    await expect(page.locator(".heartbeat-card")).toContainText(/Live project status|实时项目状态/i);
  });
});
