/**
 * ReviewWorkload tests — AC-REV-1 … AC-REV-8, AC-REV-11, AC-REV-13,
 * AC-REV-14, AC-REV-15, and the Supervisor≠Scheduler admission proof (§39).
 *
 * Every test runs the REAL workload with the REAL kernel primitives. The
 * only mocks are the OFFLINE model driver and the compatibility boundaries
 * (deterministic stage + persistence) — exactly the seams the architecture
 * defines.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityError,
  asAgentId,
  type AgentState,
  type KernelScheduler,
} from "@consistency/kernel";
import { parseReviewReport } from "@consistency/schema";
import { RepositorySnapshot } from "@consistency/repository";
import {
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
