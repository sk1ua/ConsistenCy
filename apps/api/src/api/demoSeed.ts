import {
  asAgentId,
  asRunId,
  CapabilityBroker,
  ContextManager,
  KernelScheduler,
  makePrincipalId,
  MemoryJournal,
  SandboxLifecycleBus,
  SandboxManager,
} from "@consistency/kernel";
import { demoReviewReport } from "@consistency/schema";
import type { ReviewJobStore } from "../jobQueue";
import type { NotebookStore } from "../notebook/store";
import type { RuntimeRegistry } from "../review/runtimeRegistry";

export function seedDemoData(
  store: ReviewJobStore,
  notebookStore?: NotebookStore,
  runtimeRegistry?: RuntimeRegistry,
): { created: number; notebooks?: Array<{ jobId: string; notebookId: string }> } {
  const definitions: Array<{ repository: string; pullRequestNumber: number; score?: number; status: "succeeded" | "running" | "queued" | "failed" }> = [
    { repository: "sk1ua/ConsistenCy", pullRequestNumber: 34, score: 74, status: "succeeded" as const },
    { repository: "acme/payments-api", pullRequestNumber: 182, score: 42, status: "succeeded" as const },
    { repository: "studio/design-system", pullRequestNumber: 76, score: 91, status: "succeeded" as const },
    { repository: "acme/customer-portal", pullRequestNumber: 221, status: "running" as const },
    { repository: "acme/ops-runner", pullRequestNumber: 166, status: "queued" as const },
    { repository: "acme/billing-api", pullRequestNumber: 377, score: 62, status: "succeeded" as const },
    { repository: "acme/notifications", pullRequestNumber: 254, score: 68, status: "succeeded" as const },
    { repository: "acme/auth-service", pullRequestNumber: 312, status: "failed" as const }
  ];
  const existing = new Set(store.list().map(job => job.baseSha));
  let created = 0;

  for (const [index, definition] of definitions.entries()) {
    const baseSha = `demo-base-${index + 1}`;
    if (existing.has(baseSha)) continue;
    const deliveryId = `manual:demo:${index + 1}`;
    store.recordWebhookDelivery({
      deliveryId,
      event: "pull_request",
      action: "opened",
      status: "enqueued"
    });
    const job = store.enqueue({
      kind: "pull_request",
      deliveryId,
      repository: definition.repository,
      pullRequestNumber: definition.pullRequestNumber,
      installationId: 1,
      baseSha,
      headSha: `demo-head-${index + 1}`,
      senderLogin: "demo",
      action: "demo"
    });
    created += 1;

    if (definition.status === "running") {
      store.markRunning(job.id);
    } else if (definition.status === "failed") {
      store.markRunning(job.id);
      store.markFailed(job.id, "Demo failure: review provider unavailable");
    } else if (definition.status === "succeeded") {
      store.markRunning(job.id);
      const score = definition.score ?? 100;
      store.markSucceeded(job.id, {
        ...demoReviewReport,
        jobId: job.id,
        repositoryFullName: definition.repository,
        pullRequestNumber: definition.pullRequestNumber,
        baseSha: job.baseSha!,
        headSha: job.headSha!,
        score,
        riskLevel: score < 40 ? "critical" : score < 60 ? "high" : score < 80 ? "medium" : "low",
        summary: `Demo review for ${definition.repository} pull request #${definition.pullRequestNumber}.`,
        agentRuns: demoReviewReport.agentRuns.map(run => ({ ...run, id: `${run.id}_${index}`, jobId: job.id })),
        findings: demoReviewReport.findings.map(finding => ({ ...finding, id: `${finding.id}_${index}` })),
        createdAt: new Date(Date.now() - index * 3_600_000).toISOString()
      });
    }

    // Seed Kernel Run & Telemetry Snapshot for Task Manager
    if (runtimeRegistry && definition.status !== "queued") {
      seedRuntimeSnapshot(runtimeRegistry, job, definition.status);
    }
  }

  if (!notebookStore) return { created };
  const notebooks = store.list().map(job => {
    const ensured = notebookStore.ensureForJob(job);
    return { jobId: job.id, notebookId: ensured.notebook.id };
  });
  return { created, notebooks };
}

function seedRuntimeSnapshot(
  registry: RuntimeRegistry,
  job: import("../jobQueue").ReviewJob,
  status: "succeeded" | "running" | "failed",
): void {
  const scheduler = new KernelScheduler({ maxRunningAgents: 2 });
  const run = scheduler.registerRun({ id: asRunId(`run_${job.id}`) });
  scheduler.activateRun(run.id);

  const journal = new MemoryJournal();
  const broker = new CapabilityBroker(journal);

  const supPrincipal = { id: makePrincipalId("agent", "Supervisor", run.id), kind: "agent" as const, runId: run.id };
  const supId = asAgentId("agent_supervisor");
  scheduler.registerAgent({ id: supId, runId: run.id, priority: 10, executionDomain: "in-process" });
  broker.issue({ subject: supPrincipal, action: "repo.read", resource: { kind: "repository", id: job.repository } });

  const secPrincipal = { id: makePrincipalId("agent", "Security", run.id), kind: "agent" as const, runId: run.id };
  const secId = asAgentId("agent_security");
  scheduler.registerAgent({ id: secId, runId: run.id, parent: supId, priority: 8, executionDomain: "in-process" });
  broker.issue({ subject: secPrincipal, action: "repo.read", resource: { kind: "repository", id: job.repository } });
  broker.issue({ subject: secPrincipal, action: "llm.invoke", resource: { kind: "llm", provider: "deepseek" } });

  const corrId = asAgentId("agent_correctness");
  scheduler.registerAgent({ id: corrId, runId: run.id, parent: supId, priority: 6, executionDomain: "in-process" });

  const childId = asAgentId("agent_3rd_party_plugin");
  scheduler.registerAgent({ id: childId, runId: run.id, parent: supId, priority: 4, executionDomain: "child-process" });

  const synthId = asAgentId("agent_synthesizer");
  scheduler.registerAgent({ id: synthId, runId: run.id, parent: supId, priority: 2, executionDomain: "in-process" });

  const cm = new ContextManager();
  const baseImage = cm.createImage();
  const p1 = cm.createPage({ kind: "policy", text: "Demo policy", estimatedTokens: 120, provenance: { producer: "demo", producerVersion: "1.0.0" } });
  const p2 = cm.createPage({ kind: "task", text: "Demo task", estimatedTokens: 80, provenance: { producer: "demo", producerVersion: "1.0.0" } });
  const p3 = cm.createPage({ kind: "diff", text: "Demo diff", estimatedTokens: 450, source: { kind: "repository", repository: job.repository, sha: job.headSha!, path: "src/index.ts" }, provenance: { producer: "demo", producerVersion: "1.0.0" } });
  const p4 = cm.createPage({ kind: "evidence", text: "Demo evidence", estimatedTokens: 210, provenance: { producer: "demo", producerVersion: "1.0.0" } });

  cm.attach(baseImage, p1, "pinned");
  cm.attach(baseImage, p2, "pinned");
  cm.attach(baseImage, p3, "hot");
  cm.attach(baseImage, p4, "cold");

  const bus = new SandboxLifecycleBus();
  const sandboxManager = new SandboxManager({ events: bus });

  const agentLabels = {
    [supId]: "Supervisor",
    [secId]: "Security",
    [corrId]: "Correctness",
    [childId]: "3rdPartyPlugin",
    [synthId]: "Synthesizer",
  };

  if (status === "running") {
    scheduler.ready(supId); scheduler.admit();
    scheduler.ready(secId); scheduler.admit();
    scheduler.wait(secId, { kind: "llm", provider: "deepseek" });
    scheduler.ready(childId); scheduler.admit();

    registry.registerLiveRun({
      runId: run.id,
      jobId: job.id,
      workloadKind: "pr_review",
      scheduler,
      contextManager: cm,
      baseContextImageId: baseImage,
      broker,
      sandboxManager,
      agentLabels,
    });
  } else {
    scheduler.ready(supId); scheduler.admit(); scheduler.succeedAgent(supId);
    scheduler.ready(secId); scheduler.admit(); scheduler.succeedAgent(secId);
    scheduler.ready(corrId); scheduler.admit(); scheduler.succeedAgent(corrId);
    scheduler.ready(childId); scheduler.admit(); scheduler.succeedAgent(childId);
    scheduler.ready(synthId); scheduler.admit(); scheduler.succeedAgent(synthId);

    if (status === "failed") scheduler.failRun(run.id);
    else scheduler.succeedRun(run.id);

    registry.registerLiveRun({
      runId: run.id,
      jobId: job.id,
      workloadKind: "pr_review",
      scheduler,
      contextManager: cm,
      baseContextImageId: baseImage,
      broker,
      sandboxManager,
      agentLabels,
    });
    registry.completeRun(run.id);
  }
}
