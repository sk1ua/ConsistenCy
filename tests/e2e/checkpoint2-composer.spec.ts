import { expect, test, type Locator, type Page } from "@playwright/test";

const repositoryId = "repo-matrix";
const basePreparation = {
  repository: { id: repositoryId, displayName: "Matrix repository", sourceKind: "local_git", trust: "trusted_local" },
  sources: {
    workingTree: { available: true, changedFileCount: 2 },
    branch: { available: true, base: "main", head: "feature/matrix" }
  },
  model: {
    default: { provider: "deepseek", model: "deepseek-v4-flash" },
    providers: {
      deepseek: { configured: true, defaultModel: "deepseek-v4-flash" },
      openai: { configured: true, defaultModel: "gpt-4.1-mini" }
    },
    pendingRestart: null
  },
  canStartReview: true,
  blockingReasons: []
};

type ReviewMode = "success" | "failure" | "deferred";
type Matrix = {
  preparation: typeof basePreparation;
  reviewModes: ReviewMode[];
  postBodies: unknown[];
  settingsMutations: number;
  expectedFailureResponses: number;
  releaseDeferred?: () => void;
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
  unexpectedApiRequests: string[];
  deliberateFailureResponses: number;
};

const metaCspConsoleMessage = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
const localReviewFailureConsoleMessage = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
const localReviewJobId = "job/with space";

function createMatrix(): Matrix {
  return {
    preparation: structuredClone(basePreparation),
    reviewModes: ["success"],
    postBodies: [],
    settingsMutations: 0,
    expectedFailureResponses: 0,
    pageErrors: [],
    consoleErrors: [],
    externalRequests: [],
    unexpectedApiRequests: [],
    deliberateFailureResponses: 0
  };
}

function responseForLocalReview() {
  return {
    jobId: localReviewJobId,
    repository: "Matrix repository",
    baseSha: "abcdef1",
    headSha: "1234567",
    publicationPolicy: "disabled",
    llmProvider: "deepseek",
    llmModel: "deepseek-v4-flash",
    status: "queued"
  };
}

async function installMatrix(page: Page, matrix: Matrix): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("consistency.locale.v1", "en-US"));
  page.on("pageerror", error => matrix.pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") matrix.consoleErrors.push(message.text());
  });
  page.on("request", request => {
    const url = new URL(request.url());
    const localHosts = new Set(["127.0.0.1:5173", "127.0.0.1:3001", "localhost:5173", "localhost:3001"]);
    if (!localHosts.has(url.host)) matrix.externalRequests.push(request.url());
  });
  page.on("response", response => {
    const request = response.request();
    const path = new URL(response.url()).pathname;
    if (request.method() === "POST" && path === "/api/reviews/local" && response.status() === 500) {
      matrix.deliberateFailureResponses += 1;
    }
  });
  await page.route("http://127.0.0.1:5173/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/reviews/local" && request.method() === "POST") {
      matrix.postBodies.push(request.postDataJSON());
      const mode = matrix.reviewModes.shift() ?? "success";
      if (mode === "deferred") {
        await new Promise<void>(resolve => {
          matrix.releaseDeferred = resolve;
        });
      }
      if (mode === "failure") {
        await route.fulfill({ status: 500, json: { error: { code: "provider_failure", message: "SECRET_TOKEN /private/path" } } });
        return;
      }
      await route.fulfill({ json: responseForLocalReview() });
      return;
    }
    if (path === "/api/settings" && request.method() === "PUT") {
      matrix.settingsMutations += 1;
      await route.fulfill({ json: { settings: { llm: { provider: "none", deepseekBaseUrl: "", deepseekModel: "", openaiModel: "", deepseekApiKeyConfigured: false, openaiApiKeyConfigured: false }, github: { appId: "", privateKeyConfigured: false, webhookSecretConfigured: false, publicReadTokenConfigured: false }, runtime: { storage: { kind: "memory", configured: true }, workspace: { configured: true }, localReview: { configured: true, rootCount: 1 }, workerConcurrency: 1, workerPollIntervalMs: 1000, webUrl: "http://localhost:5173", apiTokenConfigured: false }, overriddenByEnvironment: [], restartRequired: false } } });
      return;
    }
    if (path === `/api/repositories/${repositoryId}/review-preparation` && request.method() === "GET") {
      await route.fulfill({ json: matrix.preparation });
      return;
    }
    if (path === `/api/repositories/${repositoryId}/git/status` && request.method() === "GET") {
      await route.fulfill({ json: {
          repositoryId,
          available: true,
          branch: "feature/matrix",
          headSha: "abcdef1",
          dirtyFileCount: 1,
          untrackedFileCount: 1,
          changedFiles: [{
            path: "src/alpha.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
            hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: "-export const alpha = 1;\n+export const alpha = 2;\n" }]
          }],
          untrackedFiles: ["notes/local.txt"],
          remotes: []
        } });
      return;
    }
    if (path === `/api/repositories/${repositoryId}/git/commits` && request.method() === "GET") {
      await route.fulfill({ json: { repositoryId, available: true, commits: [] } });
      return;
    }
    if (path === `/api/repositories/${repositoryId}/pull-requests` && request.method() === "GET") {
      await route.fulfill({ json: { repositoryId, available: true, pullRequests: [] } });
      return;
    }
    if (path === `/api/repositories/${repositoryId}/reviews` && request.method() === "GET") {
      await route.fulfill({ json: { repositoryId, reviews: [] } });
      return;
    }
    if (path === "/api/jobs" && request.method() === "GET") {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    // The run overview route fetches the job detail when the queued job is not
    // in the (stubbed, empty) list — the same legitimate call the real page
    // makes, so it needs a canned answer instead of the 501 fallback.
    if (path.startsWith("/api/jobs/") && !path.slice("/api/jobs/".length).includes("/") && request.method() === "GET") {
      await route.fulfill({ json: { job: {
          id: localReviewJobId,
          type: "PR_REVIEW",
          status: "queued",
          repositoryFullName: "Matrix repository",
          repositoryId,
          accessMode: "local_git",
          baseSha: "abcdef1",
          headSha: "1234567",
          publicationPolicy: "disabled",
          llmProvider: "deepseek",
          llmModel: "deepseek-v4-flash",
          createdAt: "2026-08-23T00:00:00.000Z"
        } } });
      return;
    }
    if (path === "/api/reports/recent" && request.method() === "GET") {
      await route.fulfill({ json: { reports: [] } });
      return;
    }
    if (path === "/api/stats" && request.method() === "GET") {
      await route.fulfill({ json: { totalJobs: 0, succeededJobs: 0, failedJobs: 0, runningJobs: 0, averageDuration: 0, riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 }, topRepositories: [] } });
      return;
    }
    if (path === "/api/repositories" && request.method() === "GET") {
      await route.fulfill({ json: { repositories: [{ id: repositoryId, displayName: "Matrix repository", source: "local_git", trustLevel: "trusted_local", monitoringEnabled: false, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z" }] } });
      return;
    }
    if (path === "/api/health" && request.method() === "GET") {
      await route.fulfill({ json: { ok: true, service: "consistency-api", database: { ok: true }, worker: { running: false, activeJobs: 0, concurrency: 1 }, llmProvider: "deepseek", configuration: { githubAppConfigured: false, webhookSecretConfigured: false, publicReadTokenConfigured: false, storage: { kind: "memory", configured: true }, workerConcurrency: 1 } } });
      return;
    }
    if (path === "/api/audit/capabilities" && request.method() === "GET") {
      await route.fulfill({ json: { domainVersion: 2, persistence: true, repositoryRegistration: true, localPathRegistration: false, repositoryTimeline: true, repositoryMetrics: true, workflowValidation: true, automationDefinitions: true, automationScheduling: true, automationHistory: true, auditRunDrafts: true, auditExecution: false, auditRunArtifacts: true, auditRunEvents: false, auditReports: true, auditExport: false, issueTriage: true, evolutionPersistence: true, policyEvaluation: true } });
      return;
    }
    if (path === "/api/automations" && request.method() === "GET") {
      await route.fulfill({ json: { automations: [] } });
      return;
    }
    if (path === "/api/heartbeat" && request.method() === "GET") {
      await route.fulfill({ json: { pulse: null } });
      return;
    }
    if (path === "/api/heartbeat/stream" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    if (path === "/api/settings" && request.method() === "GET") {
      await route.fulfill({ json: { settings: { llm: { provider: "none", deepseekBaseUrl: "", deepseekModel: "", openaiModel: "", deepseekApiKeyConfigured: false, openaiApiKeyConfigured: false }, github: { appId: "", privateKeyConfigured: false, webhookSecretConfigured: false, publicReadTokenConfigured: false }, runtime: { storage: { kind: "memory", configured: true }, workspace: { configured: true }, localReview: { configured: true, rootCount: 1 }, workerConcurrency: 1, workerPollIntervalMs: 1000, webUrl: "http://localhost:5173", apiTokenConfigured: false }, overriddenByEnvironment: [], restartRequired: false } } });
      return;
    }
    matrix.unexpectedApiRequests.push(`${request.method()} ${path}`);
    await route.fulfill({ status: 501, json: { error: { code: "unexpected_fixture_request", message: "Unexpected API request" } } });
  });
}

function composer(page: Page): Locator {
  return page.getByRole("dialog", { name: "Start Review" });
}

function composerStartReview(page: Page): Locator {
  return composer(page).getByRole("button", { name: "Start Review", exact: true });
}

async function openComposer(page: Page): Promise<void> {
  await page.goto(`/#/repositories/${repositoryId}`);
  await expect(page.getByRole("button", { name: "Start Review", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Start Review", exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

test.describe("Checkpoint 2 Composer matrix and Repository Changes", () => {
  let matrix: Matrix;

  test.beforeEach(async ({ page }) => {
    matrix = createMatrix();
    await installMatrix(page, matrix);
  });

  test.afterEach(() => {
    matrix.releaseDeferred?.();
    expect(matrix.pageErrors).toEqual([]);
    expect(matrix.deliberateFailureResponses).toBe(matrix.expectedFailureResponses);
    const allowedFailureConsoleErrors = matrix.consoleErrors.filter(message => message === localReviewFailureConsoleMessage);
    expect(allowedFailureConsoleErrors).toHaveLength(matrix.expectedFailureResponses);
    expect(matrix.consoleErrors.filter(message => message !== metaCspConsoleMessage && message !== localReviewFailureConsoleMessage)).toEqual([]);
    expect(matrix.externalRequests).toEqual([]);
    expect(matrix.unexpectedApiRequests).toEqual([]);
  });

  test("opens the Composer from the ready repository header", async ({ page }) => {
    await openComposer(page);
    await expect(page.getByText("Working tree changes", { exact: true })).toBeVisible();
    await expect(page.getByText("Use global default", { exact: true })).toBeVisible();
  });

  test("dismisses a non-pending Composer with the close button", async ({ page }) => {
    await openComposer(page);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Start Review" })).toBeHidden();
  });

  test("dismisses a non-pending Composer with Cancel", async ({ page }) => {
    await openComposer(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Start Review" })).toBeHidden();
  });

  test("dismisses a non-pending Composer with Escape", async ({ page }) => {
    await openComposer(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Start Review" })).toBeHidden();
  });

  test("dismisses a non-pending Composer from its backdrop", async ({ page }) => {
    await openComposer(page);
    await page.locator(".ds-dialog-overlay").click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole("dialog", { name: "Start Review" })).toBeHidden();
  });

  test("submits the global working-tree payload without model fields", async ({ page }) => {
    await openComposer(page);
    await composerStartReview(page).click();
    await expect(page).toHaveURL(/#\/runs\/job%2Fwith%20space\/overview$/);
    expect(matrix.postBodies).toEqual([{ repositoryId }]);
  });

  test("submits selected branch refs with the global model", async ({ page }) => {
    await openComposer(page);
    await page.getByLabel(/Branch diff/).check();
    await composerStartReview(page).click();
    await expect(page).toHaveURL(/#\/runs\/job%2Fwith%20space\/overview$/);
    expect(matrix.postBodies).toEqual([{ repositoryId, baseRef: "main", headRef: "feature/matrix" }]);
  });

  test("submits a trimmed per-review override without mutating Settings", async ({ page }) => {
    await openComposer(page);
    await page.getByLabel(/Branch diff/).check();
    await page.getByLabel(/Use another model/).check();
    await page.getByLabel("Provider").selectOption("openai");
    await page.getByRole("textbox", { name: "Model" }).fill("  gpt-matrix  ");
    await composerStartReview(page).click();
    await expect(page).toHaveURL(/#\/runs\/job%2Fwith%20space\/overview$/);
    expect(matrix.postBodies).toEqual([{
      repositoryId,
      baseRef: "main",
      headRef: "feature/matrix",
      model: { provider: "openai", model: "gpt-matrix" }
    }]);
    expect(matrix.settingsMutations).toBe(0);
  });

  test("blocks empty and unconfigured custom choices before POST", async ({ page }) => {
    await openComposer(page);
    await page.getByLabel(/Use another model/).check();
    await page.getByRole("textbox", { name: "Model" }).fill("   ");
    await expect(page.getByRole("alert")).toHaveText("Enter a model name.");
    await expect(composerStartReview(page)).toBeDisabled();
    expect(matrix.postBodies).toEqual([]);

    matrix.preparation = {
      ...structuredClone(basePreparation),
      model: {
        ...structuredClone(basePreparation.model),
        providers: { deepseek: { configured: false }, openai: { configured: false } }
      }
    };
    await page.reload();
    await page.getByRole("button", { name: "Start Review", exact: true }).click();
    await page.getByLabel(/Use another model/).check();
    await expect(page.getByRole("alert")).toHaveText("That provider is not configured.");
    await expect(composerStartReview(page)).toBeDisabled();
    expect(matrix.postBodies).toEqual([]);
  });

  test("coalesces rapid double activation into one POST", async ({ page }) => {
    await openComposer(page);
    const start = composerStartReview(page);
    // A rapid double activation delivers both click events before React can
    // re-render the pending state, so both run through the submission gate.
    // Two concurrent full click() pipelines cannot model this: the first
    // click's success navigation unmounts the dialog, leaving the second
    // click waiting forever for a stable element (test-timeout flake).
    await start.evaluate(element => {
      element.click();
      element.click();
    });
    await expect(page).toHaveURL(/#\/runs\/job%2Fwith%20space\/overview$/);
    expect(matrix.postBodies).toHaveLength(1);
  });

  test("keeps the dialog open after a safe failure and retries successfully", async ({ page }) => {
    matrix.reviewModes = ["failure", "success"];
    matrix.expectedFailureResponses = 1;
    await openComposer(page);
    const start = composerStartReview(page);
    await start.click();
    await expect(page.getByRole("dialog", { name: "Start Review" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("Request failed. Please try again later.");
    await expect(page.getByRole("dialog")).not.toContainText("SECRET_TOKEN");
    await expect(page.getByRole("dialog")).not.toContainText("/private/path");
    await start.click();
    await expect(page).toHaveURL(/#\/runs\/job%2Fwith%20space\/overview$/);
    expect(matrix.postBodies).toHaveLength(2);
  });

  test("locks dismissal and mutable Composer controls while submission is pending", async ({ page }) => {
    matrix.reviewModes = ["deferred"];
    await openComposer(page);
    await page.getByLabel(/Use another model/).check();
    await composerStartReview(page).click();
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(page.getByLabel(/Working tree changes/)).toBeDisabled();
    await expect(page.getByLabel(/Branch diff/)).toBeDisabled();
    await expect(page.getByLabel(/Use another model/)).toBeDisabled();
    await expect(page.getByLabel("Provider")).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Model" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.locator(".ds-dialog-overlay").click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole("dialog", { name: "Start Review" })).toBeVisible();
    expect(matrix.postBodies).toHaveLength(1);
    matrix.releaseDeferred?.();
    await expect(page).toHaveURL(/#\/runs\/job%2Fwith%20space\/overview$/);
  });

  test("takes the no-LLM Settings action without a Settings mutation", async ({ page }) => {
    matrix.preparation = {
      ...structuredClone(basePreparation),
      model: {
        default: { provider: "none", model: "" },
        providers: { deepseek: { configured: false }, openai: { configured: false } },
        pendingRestart: null
      },
      canStartReview: true,
      blockingReasons: ["No language model is configured."]
    };
    await openComposer(page);
    await composer(page).getByRole("button", { name: "Configure model", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    expect(matrix.settingsMutations).toBe(0);
  });

  test("disables and enables Start Review from server-owned readiness", async ({ page }) => {
    matrix.preparation = { ...structuredClone(basePreparation), canStartReview: false, blockingReasons: ["Review is not ready."] };
    await page.goto(`/#/repositories/${repositoryId}`);
    await expect(page.getByRole("button", { name: "Start Review", exact: true })).toBeDisabled();
    matrix.preparation = { ...structuredClone(basePreparation), canStartReview: true, blockingReasons: [] };
    await page.reload();
    await expect(page.getByRole("button", { name: "Start Review", exact: true })).toBeEnabled();
  });

  test("selects tracked and untracked Changes entries by click and arrow keys", async ({ page }) => {
    await page.goto(`/#/repositories/${repositoryId}`);
    await page.getByRole("tab", { name: /Changes/ }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/repositories\\/${repositoryId}\\/changes$`));
    const tracked = page.getByRole("option", { name: /src\/alpha\.ts/ });
    const untracked = page.getByRole("option", { name: /notes\/local\.txt/ });
    await expect(tracked).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-content")).toContainText("export const alpha = 2;");
    await untracked.click();
    await expect(untracked).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-content")).toContainText("Untracked file");
    await untracked.press("ArrowUp");
    await expect(tracked).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-content")).toContainText("export const alpha = 2;");
    await tracked.press("ArrowDown");
    await expect(untracked).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".diff-content")).toContainText("notes/local.txt");
  });
});
