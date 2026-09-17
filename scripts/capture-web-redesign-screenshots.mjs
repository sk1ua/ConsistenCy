#!/usr/bin/env node
/**
 * Capture demo screenshots for the Cordis agent-desktop redesign.
 * Uses a running Vite preview/dev server (CONSISTENCY_WEB_URL).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "artifacts/web-redesign");
mkdirSync(outDir, { recursive: true });
const baseURL = process.env.CONSISTENCY_WEB_URL ?? "http://127.0.0.1:4173";

const now = "2026-08-28T00:00:00.000Z";
const repo = {
  id: "repo-demo",
  displayName: "demo-repo",
  source: "local_git",
  trustLevel: "trusted_local",
  monitoringEnabled: true,
  defaultBranch: "main",
  createdAt: now,
  updatedAt: now,
};
const nodeTypes = [
  {
    type: "analyzer.deterministic-evidence",
    serviceRef: "deterministic-evidence.analyzer",
    role: "analyzer",
    description: "Deterministic evidence analyzer",
    capabilityRequirements: [],
    coeffects: [],
    parameterSchema: { fields: [] },
  },
  {
    type: "verifier.policy",
    serviceRef: "policy.verifier",
    role: "verifier",
    description: "Policy verifier",
    capabilityRequirements: [],
    coeffects: [],
    parameterSchema: { fields: [] },
  },
];
const definition = {
  id: "verified-mini-review",
  version: 1,
  nodes: [
    {
      id: "analyze",
      type: nodeTypes[0].type,
      serviceRef: nodeTypes[0].serviceRef,
      parameters: {},
      failurePolicy: "fail-closed",
    },
    {
      id: "verify",
      type: nodeTypes[1].type,
      serviceRef: nodeTypes[1].serviceRef,
      parameters: {},
      failurePolicy: "fail-closed",
    },
  ],
  edges: [{ from: "analyze", to: "verify" }],
  metadata: { purpose: "Mini review pipeline" },
};
const revision = {
  revisionId: "wfrev_builtin_verified-mini-review_v1",
  definitionId: definition.id,
  revision: 1,
  status: "validated",
  definition,
  validationIssues: [],
  createdAt: now,
};
const summary = {
  definitionId: definition.id,
  origin: "builtin",
  latestRevision: 1,
  latestRevisionId: revision.revisionId,
  status: "validated",
  createdAt: now,
  updatedAt: now,
};

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // retry
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server not ready: ${url}`);
}

async function main() {
  await waitForServer(baseURL);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem("consistency.theme.v1", "light");
    localStorage.setItem("consistency.locale.v1", "zh-CN");
    try { sessionStorage.setItem("consistency.selectedRepo.v1", "repo-demo"); } catch {}
  });

  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "") || url.pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/health") {
      return json({ ok: true, llmProvider: "openai", llmModel: "gpt-demo", publicPrAccessMode: "anonymous" });
    }
    const demoJob = {
      id: "job_demo_review",
      type: "PR_REVIEW",
      status: "succeeded",
      repositoryFullName: repo.displayName,
      repositoryId: repo.id,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "1234567890abcdef1234567890abcdef12345678",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      createdAt: now,
      finishedAt: now,
      report: {
        jobId: "job_demo_review",
        repositoryFullName: repo.displayName,
        baseSha: "1234567890abcdef1234567890abcdef12345678",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        summary: "Demo review succeeded with one medium finding",
        score: 88,
        riskLevel: "low",
        agentRuns: [],
        findings: [{
            id: "finding_1",
            agent: "Maintainability",
            title: "Prefer explicit error boundaries",
            severity: "medium",
            confidence: "likely",
            file: "apps/web/src/shell/AppShell.tsx",
            evidence: "Catch blocks swallow errors without surfacing provenance.",
            reasoning: "Silent failures hide review harness failures from operators.",
            recommendation: "Surface a typed notice when shell queries fail.",
            startLine: 120,
            endLine: 140,
            tags: ["web", "shell"]
          }],
        createdAt: now,
      },
    };
    if (path === "/jobs") return json({ jobs: [demoJob] });
    if (path === "/jobs/job_demo_review") return json({ job: demoJob });
    if (path === "/jobs/job_demo_review/report") return json({ report: demoJob.report });
    if (path === "/reports/recent") return json({ reports: [] });
    if (path === "/stats") {
      return json({
        totalJobs: 0,
        runningJobs: 0,
        succeededJobs: 0,
        failedJobs: 0,
        averageDuration: 0,
        riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 },
        topRepositories: [],
      });
    }
    if (path === "/repositories") return json({ repositories: [repo] });
    if (path === "/automations") return json({ automations: [{
      id: "automation-demo",
      repositoryId: repo.id,
      name: "PR safety gate",
      trigger: { type: "repository_event", eventTypes: ["pull_request"], debounceMs: 5000 },
      workflowRevisionId: revision.revisionId,
      policyRevisionId: "policy-revision-demo",
      executionProfile: "static_readonly",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }] });
    if (path === "/audit/capabilities") {
      return json({ notebook: false, workflowRuntime: true, publicPr: true });
    }
    if (path === `/repositories/${repo.id}/git/status`) {
      return json({
        repositoryId: repo.id,
        available: true,
        branch: "main",
        headSha: "abcdef1234567890",
        dirtyFileCount: 2,
        untrackedFileCount: 1,
        changedFiles: [
          {
            path: "apps/web/src/shell/AppShell.tsx",
            status: "modified",
            additions: 12,
            deletions: 3,
            binary: false,
            hunks: [{
              header: "@@ -120,6 +120,15 @@",
              oldStart: 120,
              oldLines: 6,
              newStart: 120,
              newLines: 15,
              content: "   const showRelatedRail = true;\n-  // legacy\n+  const routeRunId = path.match(/^\\/runs\\//);\n+  return Boolean(activeRepo);\n "
            }]
          },
          {
            path: "README.md",
            status: "modified",
            additions: 4,
            deletions: 1,
            binary: false,
            hunks: [{
              header: "@@ -1,3 +1,6 @@",
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 6,
              content: " # ConsistenCy\n+\n+Evidence-grounded review harness.\n "
            }]
          },
        ],
        untrackedFiles: ["scratch.demo.tmp"],
        remotes: [],
      });
    }
    if (path === `/repositories/${repo.id}/git/file`) {
      const filePath = url.searchParams.get("path") || "";
      if (filePath === "package.json") {
        return json({
          repositoryId: repo.id,
          path: "package.json",
          available: true,
          encoding: "utf-8",
          truncated: false,
          size: 120,
          content: '{\n  "name": "demo-repo",\n  "private": true\n}\n',
          binary: false
        });
      }
      return json({
        repositoryId: repo.id,
        path: filePath,
        available: true,
        encoding: "utf-8",
        truncated: false,
        size: 40,
        content: "// demo preview\n",
        binary: false
      });
    }
    if (path === "/policy-revisions") return json({ policyRevisions: [] });
    if (path === "/workflow-revisions") return json({ workflowRevisions: [] });
    if (path === "/catalog/engine-allowlist") {
      return json({
        catalog: {
          analyzers: ["engine.style", "engine.security", "tool.eslint"],
          verifiers: ["verify.syntax", "verify.unit_tests"],
          synthesizerKinds: ["synthesize.review_report"],
          builtinWorkflows: [],
          engineLegacyBuiltins: [],
          runtimeVerifiedBuiltins: []
        }
      });
    }
    if (path === `/repositories/${repo.id}/git/tree`) {
      const dir = url.searchParams.get("path") || "";
      if (dir === "apps") {
        return json({
          repositoryId: repo.id,
          available: true,
          revision: "abcdef1234567890abcdef1234567890abcdef12",
          path: "apps",
          truncated: false,
          entries: [
            { path: "apps/web", name: "web", type: "tree", changeKind: "changed" },
          ],
        });
      }
      if (dir === "apps/web") {
        return json({
          repositoryId: repo.id,
          available: true,
          revision: "abcdef1234567890abcdef1234567890abcdef12",
          path: "apps/web",
          truncated: false,
          entries: [
            { path: "apps/web/src", name: "src", type: "tree", changeKind: "changed" },
          ],
        });
      }
      if (dir === "apps/web/src") {
        return json({
          repositoryId: repo.id,
          available: true,
          revision: "abcdef1234567890abcdef1234567890abcdef12",
          path: "apps/web/src",
          truncated: false,
          entries: [
            { path: "apps/web/src/shell", name: "shell", type: "tree", changeKind: "changed" },
          ],
        });
      }
      if (dir === "apps/web/src/shell") {
        return json({
          repositoryId: repo.id,
          available: true,
          revision: "abcdef1234567890abcdef1234567890abcdef12",
          path: "apps/web/src/shell",
          truncated: false,
          entries: [
            {
              path: "apps/web/src/shell/AppShell.tsx",
              name: "AppShell.tsx",
              type: "blob",
              sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              size: 2400,
              changeKind: "changed",
            },
          ],
        });
      }
      return json({
        repositoryId: repo.id,
        available: true,
        revision: "abcdef1234567890abcdef1234567890abcdef12",
        path: "",
        truncated: false,
        entries: [
          { path: "apps", name: "apps", type: "tree", changeKind: "changed" },
          {
            path: "README.md",
            name: "README.md",
            type: "blob",
            sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            size: 512,
            changeKind: "changed",
          },
          {
            path: "scratch.demo.tmp",
            name: "scratch.demo.tmp",
            type: "blob",
            changeKind: "untracked",
          },
          {
            path: "package.json",
            name: "package.json",
            type: "blob",
            sha: "cccccccccccccccccccccccccccccccccccccccc",
            size: 800,
            changeKind: "unchanged",
          },
        ],
      });
    }
    if (path === `/repositories/${repo.id}/git/commits`) {
      return json({
        repositoryId: repo.id,
        available: true,
        commits: [
          {
            sha: "abcdef1234567890abcdef1234567890abcdef12",
            parentShas: [],
            author: { name: "demo", email: "demo@example.com" },
            authoredAt: now,
            message: "Seed demo commit",
          },
        ],
      });
    }
    if (path === `/repositories/${repo.id}/review-preparation`) {
      return json({
        repository: {
          id: repo.id,
          displayName: repo.displayName,
          sourceKind: "local_git",
          trust: "trusted_local",
        },
        sources: {
          workingTree: { available: true, changedFileCount: 3 },
          branch: { available: true, base: "main", head: "abcdef1234567890abcdef1234567890abcdef12" },
        },
        model: {
          default: { provider: "openai", model: "gpt-demo" },
          providers: [{ id: "openai", label: "OpenAI", configured: true }],
          pendingRestart: null,
        },
        canStartReview: true,
        blockingReasons: [],
      });
    }
    if (path === `/repositories/${repo.id}/reviews`) {
      return json({
        repositoryId: repo.id,
        reviews: [{
          id: "job_demo_review",
          type: "PR_REVIEW",
          status: "succeeded",
          repositoryFullName: repo.displayName,
          repositoryId: repo.id,
          accessMode: "local_git",
          publicationPolicy: "disabled",
          baseSha: "1234567890abcdef1234567890abcdef12345678",
          headSha: "abcdef1234567890abcdef1234567890abcdef12",
          createdAt: now,
          finishedAt: now,
          report: {
            jobId: "job_demo_review",
            repositoryFullName: repo.displayName,
            baseSha: "1234567890abcdef1234567890abcdef12345678",
            headSha: "abcdef1234567890abcdef1234567890abcdef12",
            summary: "Demo review succeeded",
            score: 88,
            riskLevel: "low",
            agentRuns: [],
            findings: [{
            id: "finding_1",
            agent: "Maintainability",
            title: "Prefer explicit error boundaries",
            severity: "medium",
            confidence: "likely",
            file: "apps/web/src/shell/AppShell.tsx",
            evidence: "Catch blocks swallow errors without surfacing provenance.",
            reasoning: "Silent failures hide review harness failures from operators.",
            recommendation: "Surface a typed notice when shell queries fail.",
            startLine: 120,
            endLine: 140,
            tags: ["web", "shell"]
          }],
            createdAt: now,
          },
        }],
      });
    }
    if (path === "/workflow-runtime/overview") return json({ definition, nodeTypes });
    if (path === "/workflow-runtime/definitions") return json({ definitions: [summary] });
    if (path.includes("/revisions/") && path.includes("/dry-load")) {
      return json({
        definitionId: definition.id,
        revisionId: revision.revisionId,
        overall: "feasible",
        nodes: [],
        disclaimer:
          "feasibility-check-only: a successful dry-load does not authorize any syscall; every protected operation is authorized per-call by the Kernel at execution time",
      });
    }
    if (path.includes("/revisions/")) return json({ revision });
    if (path === "/workflow-runtime/runs") return json({ runs: [] });
    if (path === `/workflow-runtime/repositories/${repo.id}/bindings`) {
      return json({ bindings: [{
        definitionId: "verified-mini-review",
        repositoryId: repo.id,
        enabled: true,
        triggerMode: "manual",
      }] });
    }
    // Heartbeat / SSE endpoints — empty OK
    if (path.includes("heartbeat") || path.includes("pulse") || path.includes("events")) {
      return json({ ok: true });
    }
    return json({ error: "mock-miss", path }, 404);
  });

  const shots = [
    { hash: "#/inbox", file: "01-inbox.png", wait: ".review-workbench, .agent-shell" },
    { hash: `#/repositories/${encodeURIComponent(repo.id)}/changes`, file: "02-repository-overview.png", wait: ".agent-shell, .diff-viewer, .repo-detail-page" },
    { hash: "#/runs/job_demo_review/overview", file: "03-workflow-studio.png", wait: ".agent-shell, .run-shell-chrome, .report-page, .review-overview-page" },
  ];

  for (const shot of shots) {
    await page.goto(`${baseURL.replace(/\/$/, "")}/${shot.hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    try {
      await page.waitForSelector(shot.wait, { timeout: 10000 });
    } catch {
      // still capture
    }
    // Prefer changes + highlight for 02: select README.md row so hunks/highlight show.
    if (shot.file === "02-repository-overview.png") {
      try {
        const row = page.locator(".diff-tree-file", { hasText: "README.md" }).first();
        await row.click({ timeout: 5000 });
        await page.waitForTimeout(500);
      } catch {
        // keep default selection
      }
    }
    if (shot.file.includes("workflow")) {
      try {
        await page.waitForSelector(".studio-library, .studio-graph, .runtime-studio, .run-shell-chrome, .report-page", { timeout: 8000 });
        await page.waitForTimeout(600);
      } catch {
        // capture whatever rendered
      }
    }
    const target = join(outDir, shot.file);
    await page.screenshot({ path: target, fullPage: false });
    console.log("wrote", target);
  }

  // Maturity surfaces
  for (const extra of [
    { hash: "#/automation", file: "04-automation-stub.png", wait: "[data-testid=automation-page], .automation-page" },
    { hash: "#/plugins", file: "05-plugins-stub.png", wait: "[data-testid=plugins-page], .plugins-page" },
    { hash: "#/automation", file: "08-automation.png", wait: "[data-testid=automation-page], .automation-live" },
    { hash: "#/plugins", file: "09-plugins.png", wait: "[data-testid=plugins-page], .plugins-registry" },
  ]) {
    await page.goto(`${baseURL.replace(/\/$/, "")}/${extra.hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    try { await page.waitForSelector(extra.wait, { timeout: 8000 }); } catch {}
    const target = join(outDir, extra.file);
    await page.screenshot({ path: target, fullPage: false });
    console.log("wrote", target);
  }

  // Directory tree dialog from inbox shell
  await page.goto(`${baseURL.replace(/\/$/, "")}/#/inbox`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  try {
    await page.waitForSelector(".agent-shell, .review-workbench", { timeout: 10000 });
    const treeBtn = page.getByRole("button", { name: /目录|Tree/ }).first();
    await treeBtn.click({ timeout: 5000 });
    await page.waitForSelector(".repo-directory-tree, .repo-directory-layout", { timeout: 8000 });
    await page.waitForTimeout(500);
    // Expand apps folder for a richer tree shot
    try {
      await page.locator(".repo-directory-tree__row", { hasText: "apps" }).first().click({ timeout: 3000 });
      await page.waitForTimeout(400);
    } catch {}
    try {
      await page.locator(".repo-directory-list__item", { hasText: "package.json" }).first().click({ timeout: 3000 });
      await page.waitForTimeout(300);
    } catch {}
  } catch (err) {
    console.warn("directory tree shot prep failed", err);
  }
  const treeShot = join(outDir, "06-directory-tree.png");
  await page.screenshot({ path: treeShot, fullPage: false });
  console.log("wrote", treeShot);

  // 07 — file content preview (clean package.json)
  try {
    await page.locator(".repo-directory-list__item", { hasText: "package.json" }).first().click({ timeout: 5000 });
    await page.waitForSelector("[data-testid=repo-directory-preview-code], .repo-directory-preview__code", { timeout: 8000 });
    await page.waitForTimeout(400);
  } catch (err) {
    console.warn("file preview shot prep failed", err);
  }
  const previewShot = join(outDir, "07-file-preview.png");
  await page.screenshot({ path: previewShot, fullPage: false });
  console.log("wrote", previewShot);

  writeFileSync(join(outDir, "README.txt"), `Captured ${new Date().toISOString()} against ${baseURL}\n`);
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
