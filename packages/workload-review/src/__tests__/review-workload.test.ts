/**
 * ReviewWorkload tests — AC-REV-1 … AC-REV-8, AC-REV-11, AC-REV-13,
 * AC-REV-14, AC-REV-15, and the Supervisor≠Scheduler admission proof (§39).
 *
 * Every test runs the REAL workload with the REAL kernel primitives. The
 * only mocks are the OFFLINE model driver and the compatibility boundaries
 * (deterministic stage + persistence) — exactly the seams the architecture
 * defines.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityError,
  asAgentId,
  makePrincipalId,
  type AgentState,
  type KernelScheduler,
} from "@consistency/kernel";
import { parseReviewReport, reviewReportSchema } from "@consistency/schema";
import { RepositorySnapshot } from "@consistency/repository";
import {
  ReviewCancelledError,
  ReviewWorkload,
  type AgentAdmittedHook,
  type ReviewWorkloadOptions,
} from "../index.js";
import {
  FAKE_TOKEN,
  TestModelDriver,
  TestPersistence,
  cleanupTmpDirs,
  makeDeterministicStage,
  makeFixtureRepo,
  securityFinding,
} from "./fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_ROOT = path.resolve(HERE, "../../../kernel");

afterEach(cleanupTmpDirs);

const acb = (name: string) => asAgentId(`${name}:job_workload`);

interface Rig {
  readonly repo: { readonly baseSha: string; readonly headSha: string };
  readonly options: ReviewWorkloadOptions;
  readonly driver: TestModelDriver;
  readonly persistence: TestPersistence;
  readonly workload: ReviewWorkload;
}

function makeRig(overrides?: {
  readonly concurrency?: number;
  readonly hook?: AgentAdmittedHook;
  readonly runHook?: ReviewWorkloadOptions["onRunCreated"];
  readonly driver?: TestModelDriver;
  readonly snapshot?: ReviewWorkloadOptions["snapshot"];
  readonly stage?: ReviewWorkloadOptions["deterministic"];
  readonly plan?: ConstructorParameters<typeof TestModelDriver>[0] extends
    | { plan?: infer P }
    | undefined
    ? P
    : never;
}): Rig {
  const repo = makeFixtureRepo();
  const driver = overrides?.driver ?? new TestModelDriver({
    findingsByAgent: { Security: [securityFinding()] },
    plan: overrides?.plan,
  });
  const persistence = new TestPersistence();
  const stage = overrides?.stage ?? makeDeterministicStage();
  const options: ReviewWorkloadOptions = {
    snapshot: overrides?.snapshot ?? repo.snapshot,
    context: repo.context,
    modelDriver: driver,
    deterministic: stage,
    persistence,
    reportLanguage: "en-US",
    publicationPolicy: "github_comment",
    accessMode: "github_app",
    schedulerConcurrency: overrides?.concurrency ?? 1,
    onAgentAdmitted: overrides?.hook,
    onRunCreated: overrides?.runHook,
  };
  return { repo: { baseSha: repo.baseSha, headSha: repo.headSha }, options, driver, persistence, workload: new ReviewWorkload(options) };
}

describe("ReviewWorkload — runtime foundations", () => {
  it("AC-REV-1: a ReviewJob creates exactly one Kernel Run", async () => {
    const { workload } = makeRig();
    const result = await workload.run();

    const runs = result.scheduler.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(result.runId);
    expect(result.scheduler.getRun(result.runId)!.state).toBe("SUCCEEDED");
  });

  it("AC-REV-2: specialized Review Agents have real ACBs with parent/child relationships", async () => {
    const { workload } = makeRig();
    const result = await workload.run();

    const agents = result.scheduler.listAgents();
    const byName = new Map(agents.map((a) => [a.id, a]));
    for (const id of [
      acb("review-supervisor"),
      acb("review-deterministic"),
      acb("review-synthesizer"),
      acb("review-security"),
      acb("review-correctness"),
      acb("review-maintainability"),
      acb("review-test"),
      acb("review-style"),
      acb("review-architectureauditor"),
    ]) {
      expect(byName.has(id)).toBe(true);
    }
    for (const agent of agents) {
      expect(agent.runId).toBe(result.runId); // every ACB belongs to the one Run
    }

    const supervisor = byName.get(acb("review-supervisor"))!;
    expect(supervisor.state).toBe("SUCCEEDED");
    const specializedIds = ["security", "correctness", "maintainability", "test", "style", "architectureauditor"].map((n) => acb(`review-${n}`));
    const synthesizerId = acb("review-synthesizer");
    expect([...supervisor.children].sort()).toEqual([...specializedIds, synthesizerId].sort());
    for (const childId of specializedIds) {
      expect(byName.get(childId)!.parent).toBe(supervisor.id);
    }
    expect(byName.get(synthesizerId)!.parent).toBe(supervisor.id);
    expect(byName.get(acb("review-deterministic"))!.parent).toBeUndefined();
  });

  it("AC-REV-3: agents run on real ContextManager COW forks of the base image", async () => {
    const { workload } = makeRig();
    const result = await workload.run();

    const basePages = result.contextManager.resolve(result.baseContextImage).map((e) => e.page.id);
    expect(basePages.length).toBeGreaterThan(0);

    for (const [agentId, imageId] of result.agentContextImages) {
      expect(imageId).not.toBe(result.baseContextImage);
      // Fork observes the base snapshot: identical resolved pages.
      const agentPages = result.contextManager.resolve(imageId).map((e) => e.page.id);
      expect(agentPages).toEqual(basePages);
      // The ACB references its own context image.
      expect(result.scheduler.getAgent(asAgentId(agentId))!.contextImage).toBe(imageId);
    }
  });

  it("AC-REV-4: the Scheduler actually admits every enabled agent", async () => {
    const admitted: string[] = [];
    const { workload } = makeRig({
      hook: ({ agentName }) => {
        admitted.push(agentName);
      },
    });
    const result = await workload.run();

    // Workload-level admission hook fires exactly once per agent (the
    // Scheduler additionally re-admits inside bodies after WAIT_LLM — proven
    // by AC-REV-5 and by the terminal SUCCEEDED states below).
    for (const name of ["review-supervisor", "review-deterministic", "review-security", "review-synthesizer"]) {
      const count = name === "review-deterministic" ? 0 : 1; // deterministic stage has no hook
      expect(admitted.filter((n) => n === name)).toHaveLength(count);
    }
    expect(admitted).not.toContain("review-architectureauditor"); // skipped by fixture plan

    expect(result.scheduler.getAgent(acb("review-architectureauditor"))!.state).toBe("CANCELLED");
    expect(result.scheduler.getAgent(acb("review-security"))!.state).toBe("SUCCEEDED");
    expect(result.scheduler.getAgent(acb("review-supervisor"))!.state).toBe("SUCCEEDED");
    expect(result.scheduler.getAgent(acb("review-synthesizer"))!.state).toBe("SUCCEEDED");
    expect(result.scheduler.getAgent(acb("review-deterministic"))!.state).toBe("SUCCEEDED");
  });

  it("AC-REV-5: WAIT_LLM / WAIT_TOOL transitions occur around protected operations", async () => {
    const schedulerRef: { current?: KernelScheduler } = {};
    const driver = new TestModelDriver({
      findingsByAgent: { Security: [securityFinding()] },
      schedulerRef,
    });
    const onComposeStates: AgentState[] = [];
    const stage = makeDeterministicStage({
      onCompose: () => {
        if (schedulerRef.current) {
          onComposeStates.push(schedulerRef.current.getAgent(acb("review-synthesizer"))!.state);
        }
      },
    });
    const { workload } = makeRig({
      driver,
      stage,
      hook: ({ scheduler }) => {
        schedulerRef.current = scheduler;
      },
    });
    await workload.run();

    const findingsInvocations = driver.invocations.filter((i) => i.schemaName === "findings");
    expect(findingsInvocations.length).toBeGreaterThan(0);
    for (const invocation of findingsInvocations) {
      expect(invocation.state).toBe("WAIT_LLM");
    }
    expect(driver.invocations.filter((i) => i.schemaName === "review-plan").every((i) => i.state === "WAIT_LLM")).toBe(true);
    expect(onComposeStates).toEqual(["WAIT_TOOL"]);
  });

  it("AC-REV-6: each agent receives only its declared capability profile", async () => {
    const { workload } = makeRig();
    const result = await workload.run();

    const security = result.agentCapabilities.get(acb("review-security"))!;
    expect(security.llm).toBeDefined();
    expect(security.repo).toBeDefined();
    expect(security.evidenceRead).toBeDefined();
    expect(security.evidenceWrite).toBeDefined();

    const style = result.agentCapabilities.get(acb("review-style"))!;
    expect(style.llm).toBeDefined();
    expect(style.repo).toBeDefined();
    expect(style.evidenceRead).toBeDefined();
    expect(style.evidenceWrite).toBeUndefined(); // least privilege

    const synthesizer = result.agentCapabilities.get(acb("review-synthesizer"))!;
    expect(synthesizer.llm).toBeDefined();
    expect(synthesizer.evidenceRead).toBeDefined();
    expect(synthesizer.repo).toBeUndefined();
    expect(synthesizer.evidenceWrite).toBeUndefined();

    const allowed = new Set(["repo.read", "ast.query", "evidence.read", "evidence.write", "llm.invoke"]);
    for (const agent of result.scheduler.listAgents()) {
      for (const ref of agent.capabilities) {
        expect(allowed.has(ref.action)).toBe(true); // never github.publish / repo.write
      }
    }
  });

  it("AC-REV-7: revoked capability → next protected operation DENIED even with an ACTIVE fiber", async () => {
    const hookEvents: { agentName: string; fiberState: number; denied?: string }[] = [];
    let repoReads = 0;
    const repo = makeFixtureRepo();
    const countingSnapshot = {
      id: repo.snapshot.id,
      identity: () => repo.snapshot.identity(),
      readFile: (p: string) => {
        repoReads += 1;
        return repo.snapshot.readFile(p);
      },
    };
    const { workload } = makeRig({
      snapshot: countingSnapshot as ReviewWorkloadOptions["snapshot"],
      hook: async ({ agentName, fiberState, revoke, facades }) => {
        if (agentName !== "review-security") return;
        revoke("repo"); // Kernel revocation while the fiber is ACTIVE
        const readsBefore = repoReads;
        let denied: string | undefined;
        try {
          await facades.repo!.readFile("src/index.ts");
          denied = "ALLOWED";
        } catch (err) {
          denied = (err as CapabilityError).reason;
        }
        hookEvents.push({ agentName, fiberState, denied });
        expect(repoReads).toBe(readsBefore); // trusted handler NOT invoked for the stale call
      },
    });
    await workload.run();

    expect(hookEvents[0]!.fiberState).toBe(2); // fiber ACTIVE at revocation
    expect(hookEvents[0]!.denied).toBe("revoked");
  });

  it("AC-REV-8: deterministic PR-4 evidence enters the EvidenceStore and the context image", async () => {
    const { workload } = makeRig();
    const result = await workload.run();

    const rules = result.evidence.map((e) => e.ruleId);
    expect(rules).toContain("secret.github-token");
    expect(rules).toContain("style.trailing-whitespace");
    expect(rules).toContain("style.too-many-parameters");
    expect(JSON.stringify(result.evidence)).not.toContain(FAKE_TOKEN);

    const kinds = result.contextManager.resolve(result.baseContextImage).map((e) => e.page.kind);
    for (const kind of ["evidence", "policy", "task", "diff", "source"]) {
      expect(kinds).toContain(kind);
    }
  });

  it("AC-REV-11: the ReviewReport remains compatible with API serialization", async () => {
    const { workload, repo } = makeRig();
    const result = await workload.run();

    const roundTripped = parseReviewReport(JSON.parse(JSON.stringify(result.report)));
    expect(roundTripped.jobId).toBe("job_workload");
    expect(roundTripped.baseSha).toBe(repo.baseSha);
    expect(roundTripped.headSha).toBe(repo.headSha);
    expect(roundTripped.findings.some((f) => f.title === securityFinding().title)).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain(FAKE_TOKEN);
  });

  it("AC-REV-12: final synthesis preserves deterministic duplicate disclosure", async () => {
    const correctnessVariant = {
      ...securityFinding(),
      id: "finding-correctness-duplicate",
      agent: "Correctness" as const,
      title: "Hardcoded synthetic credential in source",
      severity: "medium" as const,
      confidence: "confirmed" as const,
      startLine: 2,
      endLine: 2,
    };
    const driver = new TestModelDriver({
      findingsByAgent: {
        Security: [securityFinding()],
        Correctness: [correctnessVariant],
      },
    });
    const { workload } = makeRig({ driver });

    const result = await workload.run();

    expect(result.report.findings.map(finding => finding.id)).toEqual(["finding-1"]);
    expect(result.report.duplicates?.map(finding => finding.id)).toEqual(["finding-correctness-duplicate"]);
    expect(result.report.riskBand).toBe("high");
  });

  it("AC-REV-13: Run cancellation prevents further Agent admission", async () => {
    let workloadRef: ReviewWorkload | null = null;
    const admittedNames: string[] = [];
    const rig = makeRig({
      hook: async ({ agentName }) => {
        admittedNames.push(agentName);
        if (agentName === "review-security") {
          workloadRef!.cancelRun(); // cancel during the first specialized agent
        }
      },
    });
    workloadRef = rig.workload;

    await expect(rig.workload.run()).rejects.toThrow(/cancelled before synthesis/);

    expect(rig.persistence.persistCalls).toHaveLength(0); // no durable report
    expect(admittedNames).toContain("review-security");
    expect(admittedNames).not.toContain("review-correctness"); // admission stopped
  });

  it("AC-REV-14: AgentRun telemetry is NOT runtime authority", async () => {
    const { workload, persistence } = makeRig();
    const result = await workload.run();

    const skipped = acb("review-architectureauditor");
    expect(result.scheduler.getAgent(skipped)!.state).toBe("CANCELLED");

    persistence.saveAgentRun({
      id: "agent_telemetry",
      jobId: "job_workload",
      agentName: "ArchitectureAuditor",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      inputSummary: "telemetry claim",
      findings: [securityFinding()],
    });
    expect(result.scheduler.getAgent(skipped)!.state).toBe("CANCELLED");
  });

  it("AC-REV-15: the Kernel remains Cordis- and workload-independent", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(KERNEL_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown> };
    expect(pkg.dependencies ?? {}).not.toHaveProperty("cordis");
    expect(pkg.dependencies ?? {}).not.toHaveProperty("@consistency/workload-review");

    const srcRoot = path.join(KERNEL_ROOT, "src");
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    })(srcRoot);

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']cordis/);
      expect(source).not.toMatch(/from\s+["'][^"']*workload-review/);
      expect(source).not.toMatch(/ReviewFinding/);
    }
  });

  it("§39: the Supervisor chooses work; the Scheduler decides admission (no bypass)", async () => {
    const admitted: string[] = [];
    const runningCounts: number[] = [];
    const { workload, persistence } = makeRig({
      concurrency: 1,
      plan: {
        enabledAgents: ["Security", "Style"],
        skippedAgents: ["Correctness", "Maintainability", "Test", "ArchitectureAuditor"],
        riskAreas: ["changed code"],
        reason: "narrow plan",
        focusAreas: [],
      },
      hook: ({ agentName, scheduler }) => {
        admitted.push(agentName);
        runningCounts.push(scheduler.listAgents().filter((a) => a.state === "RUNNING").length);
      },
    });
    await workload.run();

    const specializedAdmitted = admitted.filter((n) =>
      n.startsWith("review-") && !["review-supervisor", "review-synthesizer", "review-deterministic"].includes(n),
    );
    expect(specializedAdmitted.sort()).toEqual(["review-security", "review-style"]);
    expect(Math.max(...runningCounts)).toBe(1); // concurrency admission enforced

    const skipped = persistence.agentRuns.filter((r) => r.status === "skipped").map((r) => r.agentName);
    expect(skipped).toContain("ArchitectureAuditor");
    expect(skipped).toContain("Correctness");
  });
});

describe("ReviewWorkload — model content policy (audit P0-01)", () => {
  it("P0-01: redacted content never re-enters ANY model request via the snapshot read path", async () => {
    // The fixture repo's raw head content, diff, and patches all carry the
    // synthetic token; the SHA snapshot would happily reintroduce it after
    // the context loader's redaction. The secret-path file's UNCHANGED
    // marker lines exist only in whole-file contents (never in the diff), so
    // they prove the path gate — no text pattern matches them.
    const { workload, driver } = makeRig();
    await workload.run();

    expect(driver.requests.length).toBeGreaterThan(0);
    for (const request of driver.requests) {
      expect(request.systemPrompt ?? "").not.toContain(FAKE_TOKEN);
      expect(request.userPrompt ?? "").not.toContain(FAKE_TOKEN);
      expect(request.userPrompt ?? "").not.toContain("INTERNAL_MARKER_LINE_ONE=alpha");
      expect(request.userPrompt ?? "").not.toContain("INTERNAL_MARKER_LINE_TWO=beta");
    }
  });

  it("ContextVM conformance: the image mirrors RAW analysis bytes yet no model request reads them", async () => {
    // Product contract (P1-03 / P0-01): ContextImage pages hold the RAW
    // analysis view (grounding/evidence integrity); they are NOT a model
    // input. Every model prompt is built from the policy-applied projection
    // and re-redacted at dispatch. This pins BOTH sides of that contract: if
    // a future change starts rendering image pages into prompts, the marker
    // lines that exist only in whole-file contents (never in any diff) fail
    // this test.
    let captured: {
      contextManager: import("@consistency/kernel").ContextManager;
      baseImage: import("@consistency/kernel").ContextImageId | undefined;
    } | undefined;
    const driver = new TestModelDriver({ findingsByAgent: { Security: [securityFinding()] } });
    const rig = makeRig({
      driver,
      runHook: ({ contextManager, baseContextImage }) => {
        captured = { contextManager, baseImage: baseContextImage };
      },
    });
    await rig.workload.run();

    expect(captured).toBeDefined();
    expect(captured!.baseImage).toBeDefined();
    const image = captured!.contextManager.getImage(captured!.baseImage!);
    expect(image).toBeDefined();
    const pageTexts = image!.pages
      .map(page => captured!.contextManager.getPage(page.pageId)?.text ?? "")
      .join("\n");
    // The VM really holds the raw analysis mirror (whole-file secret-path
    // markers and the synthetic token are page content).
    expect(pageTexts).toContain("INTERNAL_MARKER_LINE_ONE=alpha");
    expect(pageTexts).toContain(FAKE_TOKEN);

    // ...and none of it ever reaches a model request.
    expect(driver.requests.length).toBeGreaterThan(0);
    for (const request of driver.requests) {
      expect(request.systemPrompt ?? "").not.toContain(FAKE_TOKEN);
      expect(request.userPrompt ?? "").not.toContain(FAKE_TOKEN);
      expect(request.userPrompt ?? "").not.toContain("INTERNAL_MARKER_LINE_ONE=alpha");
    }
  });

  it("P0-01: secret-path DIFF sections never reach the model even when no token regex matches", async () => {
    // The fixture diff embeds a whole `diff --git a/config/.env.local` section
    // whose only changed line is `+ADDED_SETTING=gamma` — an assignment whose
    // name matches NO pattern in redactModelVisibleText. Before the diff
    // section gate existed, the DIFF prompt segment carried this line verbatim.
    const { workload, driver } = makeRig();
    await workload.run();

    expect(driver.requests.length).toBeGreaterThan(0);
    for (const request of driver.requests) {
      expect(request.systemPrompt ?? "").not.toContain("ADDED_SETTING=gamma");
      expect(request.userPrompt ?? "").not.toContain("ADDED_SETTING=gamma");
      expect(request.userPrompt ?? "").not.toContain("diff --git a/config/.env.local");
    }
  });

  it("P0-01: local deterministic analysis still sees RAW snapshot bytes (evidence integrity preserved)", async () => {
    const { workload } = makeRig();
    const result = await workload.run();

    // Secret evidence only exists if the analyzers ran on un-redacted bytes.
    expect(result.evidence.map((e) => e.ruleId)).toContain("secret.github-token");
    expect(result.evidence.map((e) => e.ruleId)).toContain("style.trailing-whitespace");
  });

  it("P1-04: the durable report carries every Evidence record so findings resolve after a cold restart", async () => {
    const { workload, persistence } = makeRig();
    const result = await workload.run();
    const report = result.report;

    // The report crossing the persistence boundary carries the run's records...
    expect(report.evidence!.length).toBeGreaterThan(0);
    expect(report.evidence!.map((record) => record.ruleId)).toContain("secret.github-token");
    // ...and what was persisted is the SAME durable report.
    expect(persistence.persistCalls[0]!.report.evidence!.map((record) => record.id).sort())
      .toEqual(report.evidence!.map((record) => record.id).sort());

    // Every evidenceId a grounded finding cites must resolve inside the
    // report itself — including after a serialize/parse round-trip exactly
    // like the SQLite store performs on restart.
    const revived = reviewReportSchema.parse(JSON.parse(JSON.stringify(report)));
    const durableIds = new Set((revived.evidence ?? []).map((record) => record.id));
    expect(durableIds.size).toBe(report.evidence!.length);
    const findingsWithEvidence = report.findings.filter((finding) => (finding.evidenceIds ?? []).length > 0);
    expect(findingsWithEvidence.length).toBeGreaterThan(0);
    for (const finding of findingsWithEvidence) {
      for (const id of finding.evidenceIds ?? []) {
        expect(durableIds.has(id)).toBe(true);
      }
    }
  });
});

describe("ReviewWorkload — coverage semantics (audit P1-05) and telemetry consistency (P2-02)", () => {
  it("P1-05: all enabled specialists failing is DEGRADED coverage, never a clean success", async () => {
    const driver = new TestModelDriver({
      findingsByAgent: {},
      failAgents: ["Security", "Correctness", "Maintainability", "Test", "Style", "ArchitectureAuditor"],
    });
    const rig = makeRig({ driver });
    const result = await rig.workload.run();

    // Execution completed and a durable report exists...
    expect(result.scheduler.getRun(result.runId)!.state).toBe("SUCCEEDED");
    expect(rig.persistence.persistCalls).toHaveLength(1);
    // ...but coverage is degraded and the report says so.
    expect(result.report.coverage?.outcome).toBe("degraded");
    expect(result.report.coverage?.failedAgents).toHaveLength(5); // fixture plan enables five
    expect(result.report.coverage?.enabledAgents).toHaveLength(5);
    expect(result.report.findings).toHaveLength(0);
    expect(result.report.summary).not.toContain("No confirmed issues");
    expect(result.report.summary.toLowerCase()).toContain("coverage incomplete");
  });

  it("P1-05: a fully successful run reports complete coverage", async () => {
    const { workload } = makeRig();
    const result = await workload.run();
    expect(result.report.coverage?.outcome).toBe("complete");
    expect(result.report.coverage?.failedAgents).toHaveLength(0);
    expect(result.report.coverage?.plannerFailed).toBe(false);
    expect(result.report.coverage?.synthesizerFailed).toBe(false);
    expect(result.report.coverage?.deterministicFailed).not.toBe(true);
  });

  it("P1-09: mixed deterministic workflow steps degrade coverage without failing the run", async () => {
    const stage = makeDeterministicStage({
      analyzeConsensus: {
        status: "failed",
        steps: [
          { stepId: "security", status: "succeeded" },
          { stepId: "style", status: "failed" },
        ],
      },
    });
    const rig = makeRig({ stage });
    const result = await rig.workload.run();

    expect(result.scheduler.getRun(result.runId)!.state).toBe("SUCCEEDED");
    expect(rig.persistence.persistCalls).toHaveLength(1);
    expect(result.report.coverage?.outcome).toBe("degraded");
    expect(result.report.coverage?.deterministicFailed).toBe(true);
    expect(result.report.summary.toLowerCase()).toContain("deterministic workflow");
    expect(result.report.summary).not.toContain("No confirmed issues");
  });

  it("P1-05: planner failure degrades coverage via the fallback plan", async () => {
    const driver = new TestModelDriver({
      failPlan: true,
      findingsByAgent: { Security: [securityFinding()] },
    });
    const rig = makeRig({ driver });
    const result = await rig.workload.run();

    expect(result.report.coverage?.plannerFailed).toBe(true);
    expect(result.report.coverage?.outcome).toBe("degraded");
    expect(result.report.coverage?.enabledAgents).toHaveLength(6); // fallback plan enables all
  });

  it("P2-02: the Synthesizer appears exactly once in report telemetry and once in persisted runs", async () => {
    const { workload, persistence } = makeRig();
    const result = await workload.run();

    const persisted = persistence.agentRuns.filter((r) => r.agentName === "Synthesizer");
    const inReport = result.report.agentRuns.filter((r) => r.agentName === "Synthesizer");
    expect(persisted).toHaveLength(1);
    expect(inReport).toHaveLength(1);
    expect(inReport[0]!.id).toBe(persisted[0]!.id);
    // Every telemetry record maps 1:1 between the report and persistence.
    expect(result.report.agentRuns.map((r) => r.id).sort())
      .toEqual(persistence.agentRuns.map((r) => r.id).sort());
  });
});

describe("ReviewWorkload — cancellation and terminal revocation (audit P1-07① / P1-02)", () => {
  it("P1-07①: cancelRun aborts the in-flight provider call and surfaces as cancellation, not failure", async () => {
    let workloadRef: ReviewWorkload | undefined;
    const driver = new TestModelDriver({
      findingsByAgent: { Security: [securityFinding()] },
      hangOn: ["Security"],
      onInvoke: ({ schemaName, agent }) => {
        if (schemaName === "findings" && agent === "Security") workloadRef?.cancelRun();
      },
    });
    const rig = makeRig({ driver });

    let capturedRunId: ReturnType<KernelScheduler["registerRun"]>["id"] | undefined;
    let capturedScheduler: KernelScheduler | undefined;
    const revoked: unknown[] = [];
    const workload = new ReviewWorkload({
      ...rig.options,
      onRunCreated: info => {
        capturedRunId = info.runId;
        capturedScheduler = info.scheduler;
        const broker = info.broker as unknown as {
          revoke: (handle: unknown, principal: unknown) => unknown;
        };
        const original = broker.revoke.bind(broker);
        broker.revoke = (handle, principal) => {
          revoked.push(handle);
          return original(handle, principal);
        };
      },
    });
    workloadRef = workload;

    await expect(workload.run()).rejects.toMatchObject({ name: "ReviewCancelledError" });
    expect(ReviewCancelledError).toBeDefined();

    // The Kernel Run itself is CANCELLED, not FAILED.
    expect(capturedScheduler!.getRun(capturedRunId!)!.state).toBe("CANCELLED");
    // No agent after the cancelled one was ever invoked.
    const invokedAgents = driver.requests
      .filter(request => request.schemaName === "findings" && request.agent !== undefined)
      .map(request => request.agent);
    expect(invokedAgents).toEqual(["Security"]);
    // The in-flight call received a real abort signal.
    const securityRequest = driver.requests.find(r => r.agent === "Security");
    expect(securityRequest?.signal?.aborted).toBe(true);
    // Cancellation revoked the capabilities issued so far (audit P1-02).
    expect(revoked.length).toBeGreaterThan(0);
  });

  it("P1-07①: cancelling before run() never degrades into an all-agents-failed report", async () => {
    const rig = makeRig();
    rig.workload.cancelRun();
    await expect(rig.workload.run()).rejects.toMatchObject({ name: "ReviewCancelledError" });
    expect(rig.persistence.persistCalls).toHaveLength(0);
  });

  it("P1-02: a successful run revokes every capability it issued", async () => {
    const { workload } = makeRig();
    const result = await workload.run();
    expect(result.capabilitiesIssued).toBeGreaterThan(0);
    expect(result.capabilitiesRevoked).toBe(result.capabilitiesIssued);
  });

  it("P2-04: llm.invoke capabilities are issued with a token/call budget so commitTokens is not a no-op", async () => {
    let capturedBroker: { getRecordsForSubject: (id: ReturnType<typeof makePrincipalId>) => ReadonlyArray<{ action: string; budget?: { maxTokens?: number; maxCalls?: number } }> } | undefined;
    let capturedRunId: string | undefined;
    const rig = makeRig();
    const workload = new ReviewWorkload({
      ...rig.options,
      onRunCreated: info => {
        capturedBroker = info.broker as unknown as typeof capturedBroker;
        capturedRunId = String(info.runId);
      },
    });
    await workload.run();
    const records = capturedBroker!.getRecordsForSubject(
      makePrincipalId("agent", "review-security", capturedRunId!)
    );
    const llm = records.find(record => record.action === "llm.invoke");
    expect(llm?.budget).toEqual({ maxTokens: 250_000, maxCalls: 32 });
  });

  it("P1-02: a failed run revokes its capabilities too", async () => {
    // Fail AFTER capabilities were issued (supervisor + specialists +
    // synthesizer all registered): the durable sink breaking at the
    // persistence boundary must still not leave live capabilities behind.
    const rig = makeRig();
    const failing = new TestPersistence();
    failing.persistReportAndEnqueuePublish = () => {
      throw new Error("durable sink down");
    };
    const revoked: unknown[] = [];
    const workload = new ReviewWorkload({
      ...rig.options,
      persistence: failing,
      onRunCreated: info => {
        const broker = info.broker as unknown as {
          revoke: (handle: unknown, principal: unknown) => unknown;
        };
        const original = broker.revoke.bind(broker);
        broker.revoke = (handle, principal) => {
          revoked.push(handle);
          return original(handle, principal);
        };
      },
    });

    await expect(workload.run()).rejects.toThrow(/durable sink down/);
    expect(revoked.length).toBeGreaterThan(0);
  });

  it("P1-07①-late: a provider that ignores abort and resolves late cannot flip the cancelled run into a report", async () => {
    // Worst-case race: cancelRun fires while Security's call is in flight,
    // the provider ignores the abort and the call RESOLVES successfully late.
    // The run must still end as cancellation — the late result never produces
    // a report and never un-cancels the Kernel run.
    let releaseLate: (() => void) | undefined;
    let cancelledAt: number | undefined;
    const driver = new TestModelDriver({
      findingsByAgent: { Security: [securityFinding()] },
      onInvoke: ({ schemaName, agent }) => {
        if (schemaName === "findings" && agent === "Security") cancelledAt = Date.now();
      },
    });
    const originalFindings = driver.invokeAgentFindings.bind(driver);
    driver.invokeAgentFindings = async request => {
      const result = await originalFindings(request);
      if (request.agent === "Security" && cancelledAt !== undefined) {
        // The provider "ignored" the abort: settle late, successfully.
        await new Promise<void>(resolve => {
          releaseLate = resolve;
        });
      }
      return result;
    };

    const rig = makeRig({ driver });
    let schedulerRef: KernelScheduler | undefined;
    let runIdRef: ReturnType<KernelScheduler["registerRun"]>["id"] | undefined;
    const workload = new ReviewWorkload({
      ...rig.options,
      onRunCreated: info => {
        schedulerRef = info.scheduler;
        runIdRef = info.runId;
      },
    });

    const runPromise = workload.run();
    // Wait until the Security call is in flight, then cancel.
    await vi.waitFor(() => expect(cancelledAt).toBeDefined());
    workload.cancelRun();
    // The late resolution happens AFTER the cancel — release it.
    await vi.waitFor(() => expect(releaseLate).toBeDefined());
    releaseLate!();

    await expect(runPromise).rejects.toMatchObject({ name: "ReviewCancelledError" });
    expect(schedulerRef!.getRun(runIdRef!)!.state).toBe("CANCELLED");
    expect(rig.persistence.persistCalls).toHaveLength(0);
  });

  it("P1-07①-settle: cancelRun settles the budget ledger (releases pending reservations per issued handle)", async () => {
    let workloadRef: ReviewWorkload | undefined;
    const released: unknown[] = [];
    const driver = new TestModelDriver({
      findingsByAgent: { Security: [securityFinding()] },
      hangOn: ["Security"],
      onInvoke: ({ schemaName, agent }) => {
        if (schemaName === "findings" && agent === "Security") workloadRef?.cancelRun();
      },
    });
    const rig = makeRig({ driver });
    const workload = new ReviewWorkload({
      ...rig.options,
      onRunCreated: info => {
        const broker = info.broker as unknown as {
          releaseAllTokens: (handle: unknown) => number;
        };
        const original = broker.releaseAllTokens.bind(broker);
        broker.releaseAllTokens = (handle: unknown) => {
          released.push(handle);
          return original(handle);
        };
      },
    });
    workloadRef = workload;

    await expect(workload.run()).rejects.toMatchObject({ name: "ReviewCancelledError" });
    // Every capability handle the run issued had its PENDING reservations
    // released at cancel time; usage already committed stays on the ledger.
    expect(released.length).toBeGreaterThan(0);
  });
});

