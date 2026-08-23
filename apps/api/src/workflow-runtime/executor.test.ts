/**
 * Workflow Runtime executor tests — CKPT3 Phase 1 TEST B/C/D/E/F.
 *
 *   TEST B  full vertical: Definition → Validation → Compilation → Run → ACB
 *           → admission → Fiber → ContextImage → syscalls → Evidence →
 *           verifier → Findings/MiniReport (REAL git-backed snapshot).
 *   TEST C  capability revoked after Fiber ACTIVE → next protected syscall
 *           DENIED, handler never invoked, audit denial recorded.
 *   TEST D  Scheduler admission denied → zero protected execution.
 *   TEST E  same pinned snapshot + deterministic input → stable fingerprints.
 *   TEST F  no raw-service bypass: facades only, per-call authorization.
 *
 * Every test runs the REAL Kernel/Harness primitives; the only fixture is a
 * throwaway temp Git repository (same discipline as workload-review tests).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { asAgentId, type AuditEvent, type MemoryJournal } from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import type { WorkflowRuntimeExecutablePlan } from "@consistency/schema";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { VERIFIED_MINI_REVIEW_DEFINITION } from "./definition";
import {
  executeWorkflowPlan,
  type WorkflowSnapshotInput,
} from "./executor";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SYNTHETIC_TOKEN = `ghp_${"F".repeat(36)}`;
/** Style violation (trailing whitespace, long parameter list) + synthetic secret. */
const HEAD_CONTENT = [
  `export function risky(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}  `,
  `export const token = "${SYNTHETIC_TOKEN}";`,
  "export const fine = 1;",
].join("\n");

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

interface FixtureRepo {
  readonly repoPath: string;
  readonly headSha: string;
}

function makeFixtureRepo(): FixtureRepo {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-wf-"));
  TMP_DIRS.push(repoPath);
  git(repoPath, ["init", "-q"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), HEAD_CONTENT, "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "fixture"]);
  return { repoPath, headSha: git(repoPath, ["rev-parse", "HEAD"]) };
}

function makeInput(fixture: FixtureRepo, headSha: string = fixture.headSha): WorkflowSnapshotInput {
  return {
    repository: "test/workflow-slice",
    headSha,
    paths: ["src/index.ts"],
    snapshot: RepositorySnapshot.create({
      repositoryPath: fixture.repoPath,
      repository: "test/workflow-slice",
      headSha,
      baseSha: headSha,
    }),
  };
}

function compiledPlan(): WorkflowRuntimeExecutablePlan {
  const compilation = compileWorkflowRuntimeDefinition(VERIFIED_MINI_REVIEW_DEFINITION);
  if (!compilation.ok || !compilation.plan) {
    throw new Error("builtin definition must compile: " + JSON.stringify(compilation.errors));
  }
  return compilation.plan;
}

const ANALYZER_ACB = asAgentId("analyze:verified-mini-review");
const VERIFIER_ACB = asAgentId("verify:verified-mini-review");

function syscallEvents(journal: MemoryJournal): Extract<AuditEvent, { type: "syscall.authorised" }>[] {
  return journal
    .entries()
    .filter((event): event is Extract<AuditEvent, { type: "syscall.authorised" }> => event.type === "syscall.authorised");
}

describe("Workflow Runtime executor — TEST B: full vertical execution", () => {
  it("runs Definition → Plan → Run → ACBs → admission → Fibers → Evidence → verified Findings", async () => {
    const fixture = makeFixtureRepo();
    const result = await executeWorkflowPlan(compiledPlan(), makeInput(fixture));

    // Run lifecycle (Kernel authority).
    expect(result.status).toBe("succeeded");
    const run = result.scheduler.getRun(result.runId);
    expect(run?.state).toBe("SUCCEEDED");

    // One ACB per node, admitted and terminal.
    const analyzer = result.scheduler.getAgent(ANALYZER_ACB);
    const verifier = result.scheduler.getAgent(VERIFIER_ACB);
    expect(analyzer?.state).toBe("SUCCEEDED");
    expect(verifier?.state).toBe("SUCCEEDED");

    // Fibers actually applied (Cordis lifecycle ran; ACTIVE ≠ authorized).
    expect(result.miniReport.agents.find((agent) => agent.nodeId === "analyze")?.fiberApplied).toBeGreaterThan(0);
    expect(result.miniReport.agents.find((agent) => agent.nodeId === "verify")?.fiberApplied).toBeGreaterThan(0);

    // Context: per-agent COW forks distinct from the pinned base image.
    expect(result.agentContextImages.get("analyze")).toBeDefined();
    expect(result.agentContextImages.get("verify")).toBeDefined();
    expect(result.agentContextImages.get("analyze")).not.toBe(result.baseContextImage);
    expect(result.agentContextImages.get("verify")).not.toBe(result.baseContextImage);

    // Evidence: ≥1 real record with fingerprint + provenance at the pinned SHA.
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    for (const record of result.evidence) {
      expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(record.provenance.sha).toBe(fixture.headSha);
      expect(record.provenance.repository).toBe("test/workflow-slice");
      expect(record.provenance.analyzer).toMatch(/^(style|secret)$/);
      expect(record.provenance.analyzerVersion).toMatch(/\d+\.\d+\.\d+/);
    }

    // MiniReport: findings all evidence-linked and verified.
    expect(result.miniReport.status).toBe("succeeded");
    expect(result.miniReport.findings.length).toBeGreaterThanOrEqual(1);
    const evidenceIds = new Set<string>(result.evidence.map((record) => String(record.id)));
    for (const finding of result.miniReport.findings) {
      expect(finding.evidenceIds.length).toBeGreaterThanOrEqual(1);
      for (const id of finding.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
      expect(finding.verified).toBe(true);
    }
    expect(result.miniReport.audit.allowed).toBeGreaterThanOrEqual(3); // repo.read + evidence.write + evidence.read
  });

  it("analyzer with a clean file set fails closed (no evidence → no verifier, no pass claim)", async () => {
    const fixture = makeFixtureRepo();
    fs.writeFileSync(path.join(fixture.repoPath, "src", "index.ts"), "export const clean = 1;\n", "utf8");
    git(fixture.repoPath, ["add", "."]);
    git(fixture.repoPath, ["commit", "-q", "-m", "clean"]);
    const cleanSha = git(fixture.repoPath, ["rev-parse", "HEAD"]);
    const input: WorkflowSnapshotInput = {
      repository: "test/workflow-slice",
      headSha: cleanSha,
      paths: ["src/index.ts"],
      snapshot: RepositorySnapshot.create({
        repositoryPath: fixture.repoPath,
        repository: "test/workflow-slice",
        headSha: cleanSha,
        baseSha: cleanSha,
      }),
    };

    const result = await executeWorkflowPlan(compiledPlan(), input);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no evidence");
    expect(result.scheduler.getRun(result.runId)?.state).toBe("FAILED");
    // Verifier must not have run.
    expect(result.scheduler.getAgent(VERIFIER_ACB)).toBeUndefined();
    expect(result.miniReport.findings).toHaveLength(0);
  });
});

describe("Workflow Runtime executor — TEST C: revocation after Fiber ACTIVE", () => {
  it("revoked evidence.write → next syscall DENY, handler count 0, audit denial recorded", async () => {
    const fixture = makeFixtureRepo();
    let capturedJournal: MemoryJournal | undefined;

    const result = await executeWorkflowPlan(compiledPlan(), makeInput(fixture), {
      onRunCreated: (info) => {
        capturedJournal = info.journal;
      },
      onAgentAdmitted: (info) => {
        if (info.nodeId === "analyze") {
          expect(info.fiberState).toBe(2); // ACTIVE — but NOT authorized
          info.revoke("evidence.write");
        }
      },
    });

    expect(result.status).toBe("failed");
    expect(result.scheduler.getRun(result.runId)?.state).toBe("FAILED");
    expect(result.scheduler.getAgent(ANALYZER_ACB)?.state).toBe("FAILED");

    // Audit: the DENY was recorded (before the handler).
    const journal = capturedJournal!;
    const denies = syscallEvents(journal).filter((event) => event.decision === "deny");
    expect(denies.length).toBeGreaterThanOrEqual(1);
    expect(denies.some((event) => event.action === "evidence.write" && event.reason === "revoked")).toBe(true);

    // Handler invocation count == 0 for the denied action: nothing was written.
    const writeAllows = syscallEvents(journal).filter(
      (event) => event.action === "evidence.write" && event.decision === "allow",
    );
    expect(writeAllows).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);

    // Repo reads still succeeded (only evidence.write was revoked).
    expect(syscallEvents(journal).some((event) => event.action === "repo.read" && event.decision === "allow")).toBe(true);

    // Verifier never started.
    expect(result.miniReport.agents.map((agent) => agent.nodeId)).toEqual(["analyze"]);
    expect(result.miniReport.status).toBe("failed");
  });
});

describe("Workflow Runtime executor — TEST D: Scheduler admission authority", () => {
  it("admission denied → no protected execution begins (syscall count 0)", async () => {
    const fixture = makeFixtureRepo();
    let capturedJournal: MemoryJournal | undefined;

    const result = await executeWorkflowPlan(compiledPlan(), makeInput(fixture), {
      onRunCreated: (info) => {
        capturedJournal = info.journal;
        // Occupy the single concurrency slot with a higher-priority blocker
        // BEFORE the workflow agents are enqueued: admission authority stays
        // with the KernelScheduler alone.
        const blocker = asAgentId("admission-blocker:wf");
        info.scheduler.registerAgent({
          id: blocker,
          runId: info.runId,
          priority: 10,
          executionDomain: "in-process",
        });
        info.scheduler.ready(blocker);
        const admitted = info.scheduler.admit();
        expect(admitted?.id).toBe(blocker);
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("admission-denied");
    expect(result.scheduler.getRun(result.runId)?.state).toBe("FAILED");

    // The workflow agent never began protected execution: zero syscalls.
    const events = syscallEvents(capturedJournal!);
    expect(events).toHaveLength(0);
    expect(result.miniReport.audit).toEqual({ allowed: 0, denied: 0 });
    expect(result.evidence).toHaveLength(0);
    expect(result.miniReport.findings).toHaveLength(0);
  });
});

describe("Workflow Runtime executor — TEST E: evidence reproducibility", () => {
  it("same pinned snapshot + deterministic input → stable fingerprints and provenance", async () => {
    const fixture = makeFixtureRepo();
    const input = makeInput(fixture);

    const first = await executeWorkflowPlan(compiledPlan(), input);
    const second = await executeWorkflowPlan(compiledPlan(), input);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");

    expect(second.evidence.length).toBe(first.evidence.length);
    const byFingerprint = (records: readonly { fingerprint: string }[]) => new Set(records.map((record) => record.fingerprint));
    expect(byFingerprint(second.evidence)).toEqual(byFingerprint(first.evidence));

    for (let index = 0; index < first.evidence.length; index += 1) {
      expect(second.evidence[index]!.fingerprint).toBe(first.evidence[index]!.fingerprint);
      expect(second.evidence[index]!.provenance).toEqual(first.evidence[index]!.provenance);
    }

    // Reproducibility holds across DIFFERENT inputs too: a changed file at a
    // new SHA must not reuse fingerprints.
    fs.writeFileSync(path.join(fixture.repoPath, "src", "index.ts"), HEAD_CONTENT.replace("fine = 1", "fine = 2"), "utf8");
    git(fixture.repoPath, ["add", "."]);
    git(fixture.repoPath, ["commit", "-q", "-m", "changed"]);
    const driftedSha = git(fixture.repoPath, ["rev-parse", "HEAD"]);
    const drifted = await executeWorkflowPlan(compiledPlan(), makeInput(fixture, driftedSha));
    expect(drifted.status).toBe("succeeded");
    const base = byFingerprint(first.evidence);
    expect(drifted.evidence.some((record) => !base.has(record.fingerprint))).toBe(true);
    expect(drifted.evidence.every((record) => record.provenance.sha !== first.evidence[0]!.provenance.sha)).toBe(true);
  });
});

describe("Workflow Runtime executor — TEST F: no raw-service bypass", () => {
  it("agent facades expose no raw store/snapshot/gateway and deny per-call after revocation", async () => {
    const fixture = makeFixtureRepo();
    let seenFacades: { repoKeys: string[]; evidenceKeys: string[] } | undefined;

    const result = await executeWorkflowPlan(compiledPlan(), makeInput(fixture), {
      onAgentAdmitted: async (info) => {
        if (info.nodeId === "analyze" && info.facades.repo) {
          // Private #fields are not enumerable: no raw service is reachable.
          seenFacades = {
            repoKeys: Object.keys(info.facades.repo),
            evidenceKeys: Object.keys(info.facades.evidence),
          };
          // Behavioral: revoke EVERYTHING — the agent must not be able to
          // reach the protected services through any other path.
          info.revoke("repo.read");
          info.revoke("evidence.write");
        }
      },
    });

    expect(seenFacades?.repoKeys).toEqual([]);
    expect(seenFacades?.evidenceKeys).toEqual([]);

    expect(result.status).toBe("failed");
    // Every protected op was denied per-call: nothing read, nothing written.
    expect(result.evidence).toHaveLength(0);
    const denies = result.miniReport.audit.denied;
    expect(denies).toBeGreaterThanOrEqual(1);
  });
});
