import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// The diff workspace needs tracked changes, so the test builds a scratch
// repository with one committed file plus a working-tree modification. Using
// the live checkout (process.cwd()) is not hermetic: a clean tree yields an
// empty diff and the file list never renders.
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
      data: { repoPath: makeDiffFixture() }
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
