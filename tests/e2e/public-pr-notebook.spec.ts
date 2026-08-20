import { expect, test } from "@playwright/test";
import { createE2eGitFixture } from "./fixture";

test.describe("public PR Notebook UI", () => {
  test("opens a full-page Notebook, renders Markdown, and switches back to the review", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));

    const repoPath = createE2eGitFixture("notebook-e2e-repo");
    const localReviewResponse = await request.post("http://127.0.0.1:3001/reviews/local", {
      data: { repoPath }
    });
    expect(localReviewResponse.ok()).toBe(true);
    const { jobId } = await localReviewResponse.json() as { jobId: string };
    const notebookId = `notebook_${jobId}`;

    await page.route("**/api/reviews/public-pr", async route => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          jobId,
          notebookId,
          repository: "example/repo",
          pullRequestNumber: 9,
          baseSha: "base1234567890",
          headSha: "head1234567890",
          publicationPolicy: "disabled",
          status: "queued"
        })
      });
    });

    await page.route(`**/api/notebooks/${encodeURIComponent(notebookId)}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          notebook: {
            id: notebookId,
            repository: "example/repo",
            pullRequestNumber: 9,
            headSha: "head1234567890",
            sources: [
              {
                id: `source_${jobId}`,
                jobId,
                repository: "example/repo",
                pullRequestNumber: 9,
                headSha: "head1234567890",
                available: true
              }
            ],
            messages: [
              {
                role: "assistant",
                content: "## Evidence-first review\n\n- Inspect `engine/runner.py` first.\n- Verify the cited call path.\n\n| Signal | Priority |\n| --- | --- |\n| deterministic evidence | high |"
              }
            ],
            cards: [
              {
                id: "card_1",
                kind: "risk_brief",
                content: "## Risk brief\n\n- Review the highest-risk evidence.\n- Add a targeted regression test."
              }
            ]
          }
        })
      });
    });

    await page.goto("/#/inbox");
    const input = page.locator("input[aria-label='GitHub pull request URL']");
    if (await input.isVisible()) {
      await input.fill("https://github.com/example/repo/pull/9");
      await page.getByRole("button", { name: /Analyze PR/i }).click();
    } else {
      await page.goto(`/#/runs/${encodeURIComponent(jobId)}/notebook?notebook=${encodeURIComponent(notebookId)}`);
    }

    await expect(page.locator(".notebook-panel")).toBeVisible();
    await expect(page).toHaveURL(/#\/runs\/[^/]+\/notebook/);

    const runModeNav = page.getByLabel(/Run views|运行视图/i);
    const notebookMode = runModeNav.getByRole("tab", { name: /Notebook|笔记本/i, exact: true });
    const overviewMode = runModeNav.getByRole("tab", { name: /Overview|概览/i, exact: true });
    await expect(notebookMode).toHaveAttribute("aria-selected", "true");
    await expect(overviewMode).toHaveAttribute("aria-selected", "false");

    await overviewMode.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${encodeURIComponent(jobId)}\\/overview$`));
    await expect(overviewMode).toHaveAttribute("aria-selected", "true");

    await notebookMode.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${encodeURIComponent(jobId)}\\/notebook`));
    await expect(page.locator(".notebook-panel")).toBeVisible();
  });
});
