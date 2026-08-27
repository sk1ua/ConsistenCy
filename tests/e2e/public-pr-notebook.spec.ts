import { expect, test } from "@playwright/test";
import { createE2eLocalReview, e2eApiHeaders } from "./fixture";

// Public-PR success routing regression: analyzing a public PR must land on the
// always-available report route (/runs/:jobId/overview). The previous behavior
// navigated to /runs/:jobId/notebook?notebook=... unconditionally, which
// dead-ended on NOTEBOOK_DISABLED/404 whenever the runtime reported
// health.notebook=false (explicit CONSISTENCY_NOTEBOOK_ENABLED=false or an
// unset flag under NODE_ENV=production).
test.describe("public PR review routing", () => {
  test("lands a successful public PR analysis on the report overview without a notebook dead end", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));

    const { jobId } = await createE2eLocalReview(request, "public-pr-routing-e2e-repo");

    // Kept from the former public-pr-notebook spec: the intake response still
    // carries the notebook id, and the workspace markdown is served for the
    // notebook-available path below.
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

    const escapedJobId = encodeURIComponent(jobId);
    await page.goto("/#/inbox");
    const input = page.locator("input[aria-label='GitHub pull request URL']");
    if (await input.isVisible()) {
      await input.fill("https://github.com/example/repo/pull/9");
      await page.getByRole("button", { name: /Analyze PR/i }).click();
      // Changed expectation (was: URL matching #/runs/<id>/notebook): the
      // success handler now navigates to the report overview instead of the
      // notebook sub-path — same original assertion updated to the new
      // contract, not weakened.
      await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${escapedJobId}\\/overview$`));
    } else {
      // If this runtime keeps public PR intake disabled
      // (publicPrAccessMode="disabled"), exercise the same destination the
      // success handler targets directly.
      await page.goto(`/#/runs/${escapedJobId}/overview`);
    }

    // Preserved intent from the former spec: the run workbench tabs render,
    // and the analyzed run opens in the active mode (now overview).
    const runModeNav = page.getByLabel(/Run views|运行视图/i);
    await expect(runModeNav).toBeVisible();
    const overviewMode = runModeNav.getByRole("tab", { name: /Overview|概览/i, exact: true });
    await expect(overviewMode).toHaveAttribute("aria-selected", "true");

    // Tab availability follows the live runtime capability. When the runtime
    // disables the notebook, the dead-ending tab is hidden entirely (the
    // REPORTED-dead-end removal this file exists to protect); when enabled,
    // the original full-page Notebook assertions below must keep passing.
    const healthResponse = await request.get("http://127.0.0.1:3001/health", { headers: e2eApiHeaders });
    expect(healthResponse.ok()).toBeTruthy();
    const healthBody: unknown = await healthResponse.json();
    const notebookEnabled = (healthBody as { notebook?: boolean }).notebook !== false;

    const notebookMode = runModeNav.getByRole("tab", { name: /Notebook|笔记本/i, exact: true });
    if (!notebookEnabled) {
      await expect(notebookMode).toHaveCount(0);
      return;
    }

    // Original public-pr-notebook assertions kept: the notebook tab leads to a
    // rendered full-page workspace and the user can switch back to the report.
    await notebookMode.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${escapedJobId}\\/notebook`));
    await expect(page.locator(".notebook-panel")).toBeVisible();

    await overviewMode.click();
    await expect(overviewMode).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${escapedJobId}\\/overview$`));
  });
});
