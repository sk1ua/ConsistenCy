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
  });

  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "") || url.pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/health") {
      return json({ ok: true, llmProvider: "openai", llmModel: "gpt-demo", publicPrAccessMode: "anonymous" });
    }
    if (path === "/jobs") return json({ jobs: [{
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
    }] });
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
    if (path === "/automations") return json({ automations: [] });
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
          { path: "apps/web/src/shell/AppShell.tsx", status: "modified", additions: 12, deletions: 3, hunks: [] },
          { path: "README.md", status: "modified", additions: 4, deletions: 1, hunks: [] },
        ],
        untrackedFiles: ["scratch.demo.tmp"],
        remotes: [],
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
            findings: [],
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
      return json({ bindings: [] });
    }
    // Heartbeat / SSE endpoints — empty OK
    if (path.includes("heartbeat") || path.includes("pulse") || path.includes("events")) {
      return json({ ok: true });
    }
    return json({ error: "mock-miss", path }, 404);
  });

  const shots = [
    { hash: "#/inbox", file: "01-inbox.png", wait: ".review-workbench, .agent-shell" },
    { hash: `#/repositories/${encodeURIComponent(repo.id)}/overview`, file: "02-repository-overview.png", wait: ".agent-shell, .repo-detail-page" },
    { hash: "#/workflows", file: "03-workflow-studio.png", wait: ".runtime-studio, .workflows-page" },
  ];

  for (const shot of shots) {
    await page.goto(`${baseURL.replace(/\/$/, "")}/${shot.hash}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    try {
      await page.waitForSelector(shot.wait, { timeout: 10000 });
    } catch {
      // still capture
    }
    if (shot.file.includes("workflow")) {
      try {
        await page.waitForSelector(".studio-library, .studio-graph, .runtime-studio", { timeout: 8000 });
        await page.waitForTimeout(600);
      } catch {
        // capture whatever rendered
      }
    }
    const target = join(outDir, shot.file);
    await page.screenshot({ path: target, fullPage: false });
    console.log("wrote", target);
  }

  writeFileSync(join(outDir, "README.txt"), `Captured ${new Date().toISOString()} against ${baseURL}\n`);
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
