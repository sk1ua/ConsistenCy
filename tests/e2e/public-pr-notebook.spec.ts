import { expect, test } from "@playwright/test";

test.describe("public PR Notebook UI", () => {
  test("opens a public-read split report, streams a grounded answer, and keeps requests local", async ({ page, request }) => {
    const seedResponse = await request.post("http://127.0.0.1:3001/demo/seed", { data: {} });
    expect(seedResponse.ok()).toBe(true);
    const seed = await seedResponse.json() as { notebooks?: Array<{ jobId: string; notebookId: string }> };
    const jobsResponse = await request.get("http://127.0.0.1:3001/jobs");
    const jobs = await jobsResponse.json() as { jobs: Array<{ id: string; status: string; repositoryFullName: string; pullRequestNumber: number; baseSha: string; headSha: string }> };
    const job = jobs.jobs.find(item => item.status === "succeeded");
    expect(job).toBeDefined();
    const notebook = seed.notebooks?.find(item => item.jobId === job!.id);
    expect(notebook).toBeDefined();

    await page.route("http://127.0.0.1:3001/reviews/public-pr", async route => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          jobId: job!.id,
          notebookId: notebook!.notebookId,
          repository: job!.repositoryFullName,
          pullRequestNumber: job!.pullRequestNumber,
          baseSha: job!.baseSha,
          headSha: job!.headSha,
          publicationPolicy: "disabled",
          status: "queued"
        })
      });
    });
    await page.route("http://127.0.0.1:3001/jobs*", async route => {
      const response = await route.fetch();
      const payload = await response.json() as { jobs: Array<Record<string, unknown>> };
      payload.jobs = payload.jobs.map(item => item.id === job!.id ? { ...item, accessMode: "public_read", publicationPolicy: "disabled", installationId: undefined } : item);
      await route.fulfill({ response, json: payload });
    });

    await page.goto("http://127.0.0.1:5173");
    await expect(page.locator("h1")).toContainText(/Review overview|审查概览/i);
    const input = page.locator("input[aria-label='GitHub pull request URL']");
    await input.fill("https://github.com/example/repo/pull/9");
    await page.getByRole("button", { name: /Analyze PR/i }).click();

    await expect(page.locator(".report-workspace")).toBeVisible();
    await expect(page.locator(".notebook-panel")).toBeVisible();
    await expect(page.locator(".notebook-source-bar")).toBeVisible();
    await expect(page.locator(".report-meta")).toContainText(/analysis only/i);
    await expect(page.locator(".report-meta")).toContainText(/PUBLIC READ-ONLY/i);
    await expect(page).toHaveURL(/notebook=/);

    const question = page.locator("textarea[aria-label='Ask Repository Notebook']");
    await question.fill("Which evidence should the reviewer inspect first?");
    await page.locator(".notebook-composer button[type='submit']").click();
    await expect(page.locator(".notebook-message.assistant").last()).toContainText(/evidence|Sources/i, { timeout: 15_000 });
    await expect(page.locator(".notebook-citations").last()).toBeVisible();
    await page.getByRole("button", { name: "Risk Brief" }).click();
    await expect(page.locator(".notebook-card").first()).toBeVisible();

    await page.reload();
    await expect(page.locator(".notebook-panel")).toBeVisible();
    await expect(page.locator(".notebook-source-bar")).toBeVisible();
  });
});
