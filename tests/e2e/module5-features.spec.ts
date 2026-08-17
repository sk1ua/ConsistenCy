import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

function makeDiffFixture(): string {
  const root = process.env.CONSISTENCY_E2E_ROOT;
  if (!root) throw new Error("CONSISTENCY_E2E_ROOT is unset; run via the project playwright config");
  const repo = join(root, "diff-fixture");
  mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@consistency.local"]);
  git(["config", "user.name", "ConsistenCy E2E"]);
  writeFileSync(join(repo, "note.txt"), "first line\n");
  git(["add", "note.txt"]);
  git(["commit", "-q", "-m", "baseline"]);
  writeFileSync(join(repo, "note.txt"), "first line\nsecond line\n");
  return repo;
}

test.describe("Module 5 feature suite", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));
  });

  test("workflow builder lists builtins, creates a draft, and deletes it", async ({ page }) => {
    const draftName = `e2e-draft-${Date.now()}`;

    await page.goto("/#/inbox");
    await page.locator(".activity-rail").getByRole("link", { name: "Workflows", exact: true }).click();
    await expect(page).toHaveURL(/#\/workflows$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workflow builder");
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
    const created = await request.post("http://127.0.0.1:3001/reviews/local", {
      data: { repoPath: makeDiffFixture() }
    });
    expect(created.ok()).toBe(true);
    const body = await created.json() as { jobId: string };
    const diffResponse = await request.get(`http://127.0.0.1:3001/jobs/${body.jobId}/diff`);
    const diff = await diffResponse.json() as { available: boolean };
    expect(diffResponse.status()).toBe(200);
    expect(diff.available).toBe(true);

    await page.goto(`/#/runs/${encodeURIComponent(body.jobId)}/overview`);
    const diffTab = page.getByRole("tab", { name: "Diff", exact: true });
    await expect(diffTab).toBeVisible();
    await diffTab.click();
    await expect(page).toHaveURL(new RegExp(`#\\/runs\\/${body.jobId}\\/diff$`));
    await expect(diffTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-file-list")).toBeVisible();
    await expect(page.locator(".diff-file-list button").first()).toBeVisible();
    await expect(page.locator(".diff-grid .diff-row").first()).toBeVisible();
  });

  test("Inbox renders the live heartbeat card in development", async ({ page }) => {
    await page.goto("/#/inbox");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review inbox");
    await expect(page.locator(".ops-runtime-strip, .heartbeat-card")).toBeVisible();
    await expect(page.locator(".ops-runtime-strip, .heartbeat-card")).toContainText("Repository monitor");
  });
});
