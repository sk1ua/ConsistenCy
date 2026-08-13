import { expect, test } from "@playwright/test";

test.describe("public PR Notebook UI", () => {
  test("opens a full-page Notebook, renders Markdown, and switches back to the review", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });

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
    await page.route(`http://127.0.0.1:3001/notebooks/${encodeURIComponent(notebook!.notebookId)}`, async route => {
      const response = await route.fetch();
      const payload = await response.json() as {
        notebook: {
          messages: Array<{ role: string; content: string }>;
          cards: Array<{ content: string }>;
        };
      };
      payload.notebook.messages = payload.notebook.messages.map(message => message.role === "assistant" ? {
        ...message,
        content: "## Evidence-first review\n\n- Inspect `engine/runner.py` first.\n- Verify the cited call path.\n\n| Signal | Priority |\n| --- | --- |\n| deterministic evidence | high |"
      } : message);
      payload.notebook.cards = payload.notebook.cards.map(card => ({
        ...card,
        content: "## Risk brief\n\n- Review the highest-risk evidence.\n- Add a targeted regression test."
      }));
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

    const notebookMode = page.getByRole("button", { name: "Notebook workspace", exact: true });
    const reviewMode = page.getByRole("button", { name: "Review report", exact: true });
    await expect(notebookMode).toHaveAttribute("aria-pressed", "true");
    await expect(reviewMode).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".report-ide")).toHaveCount(0);

    const notebookBox = await page.locator(".notebook-panel").boundingBox();
    const conversationBox = await page.locator(".notebook-conversation").boundingBox();
    const messagesBox = await page.locator(".notebook-messages").boundingBox();
    expect(notebookBox).not.toBeNull();
    expect(conversationBox).not.toBeNull();
    expect(messagesBox).not.toBeNull();
    expect(notebookBox!.width).toBeGreaterThanOrEqual(1_000);
    expect(conversationBox!.width).toBeGreaterThanOrEqual(600);
    expect(messagesBox!.height).toBeGreaterThanOrEqual(440);

    await reviewMode.click();
    await expect(reviewMode).toHaveAttribute("aria-pressed", "true");
    await expect(notebookMode).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".report-ide")).toBeVisible();
    await expect(page.locator(".notebook-panel")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();

    await notebookMode.click();
    await expect(notebookMode).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".notebook-panel")).toBeVisible();
    await expect(page.locator(".report-ide")).toHaveCount(0);

    const question = page.locator("textarea[aria-label='Ask Repository Notebook']");
    await question.fill("Which evidence should the reviewer inspect first?");
    await page.locator(".notebook-composer button[type='submit']").click();
    const assistantMessage = page.locator(".notebook-message.assistant").last();
    await expect(assistantMessage).toContainText(/evidence|Sources/i, { timeout: 15_000 });
    await expect(assistantMessage.getByRole("heading", { name: "Evidence-first review", exact: true })).toBeVisible();
    await expect(assistantMessage.locator("ul > li")).toHaveCount(2);
    await expect(assistantMessage.locator("code")).toHaveText("engine/runner.py");
    await expect(assistantMessage.locator("table")).toBeVisible();
    await expect(page.locator(".notebook-citations").last()).toBeVisible();
    await page.getByRole("button", { name: "Risk Brief" }).click();
    const notebookCard = page.locator(".notebook-card").first();
    await expect(notebookCard).toBeVisible();
    await expect(notebookCard.getByRole("heading", { name: "Risk brief", exact: true })).toBeVisible();
    await expect(notebookCard.locator("ul > li")).toHaveCount(2);

    await page.reload();
    await expect(page.locator(".notebook-panel")).toBeVisible();
    await expect(page.locator(".notebook-source-bar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Notebook workspace", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".report-ide")).toHaveCount(0);
  });
});
