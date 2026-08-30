/**
 * Catalog projection tests (R1).
 *
 * The contract: every /catalog/* response is FULLY EQUAL to the in-code
 * registries it projects — asserted over the complete set (not sampled), with
 * exact ordering where the source registry is ordered. The projections must
 * stay read-only and free of secrets or filesystem paths.
 */
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import {
  AGENT_CAPABILITY_PROFILES,
  REVIEW_AGENTS,
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_FILE_CONTENTS_MAX_CHARS,
  REVIEW_KERNEL_EVIDENCE_MAX_ENTRIES,
  REVIEW_PROJECT_METADATA_MAX_CHARS,
} from "@consistency/workload-review";
import { SYSCALL_DEFINITIONS } from "@consistency/kernel";
import { analyzerKindSchema, verifierKindSchema } from "@consistency/schema";
import {
  buildEngineAllowlistCatalog,
  buildKernelSyscallCatalog,
  buildReviewPipelineCatalog
} from "./catalog";
import { createApiServer, type CreateApiServerOptions } from "../http";
import { WorkflowStore } from "../workflows/store";

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, res => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { responseBody += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody ? JSON.parse(responseBody) : {} }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  return address.port;
}

describe("buildReviewPipelineCatalog", () => {
  it("projects exactly DeterministicAnalyzer + Planner + six agents + Synthesizer", () => {
    const pipeline = buildReviewPipelineCatalog();
    expect(pipeline.members.map(member => member.key)).toEqual([
      "deterministic-analyzer",
      "Planner",
      ...REVIEW_AGENTS,
      "Synthesizer"
    ]);
    expect(pipeline.members).toHaveLength(9);
  });

  it("mirrors AGENT_CAPABILITY_PROFILES per role — full deep equality per member", () => {
    const pipeline = buildReviewPipelineCatalog();
    const planner = pipeline.members.find(member => member.key === "Planner");
    const synthesizer = pipeline.members.find(member => member.key === "Synthesizer");
    expect(planner).toEqual({
      key: "Planner",
      kind: "planner",
      capabilityProfile: "supervisor",
      grants: { ...AGENT_CAPABILITY_PROFILES.supervisor },
      grantedActions: ["repo.read", "evidence.read", "llm.invoke"]
    });
    expect(synthesizer).toEqual({
      key: "Synthesizer",
      kind: "synthesizer",
      capabilityProfile: "synthesizer",
      grants: { ...AGENT_CAPABILITY_PROFILES.synthesizer },
      grantedActions: ["evidence.read", "llm.invoke"]
    });
    for (const agent of REVIEW_AGENTS) {
      const member = pipeline.members.find(candidate => candidate.key === agent);
      expect(member).toEqual(
        agent === "Security"
          ? {
              key: agent,
              kind: "specialized-agent",
              agentName: agent,
              capabilityProfile: "security",
              grants: { ...AGENT_CAPABILITY_PROFILES.security },
              grantedActions: ["repo.read", "ast.query", "evidence.read", "evidence.write", "llm.invoke"]
            }
          : {
              key: agent,
              kind: "specialized-agent",
              agentName: agent,
              capabilityProfile: "specialized",
              grants: { ...AGENT_CAPABILITY_PROFILES.specialized },
              grantedActions: ["repo.read", "ast.query", "evidence.read", "llm.invoke"]
            }
      );
    }
  });

  it("keeps grantedActions consistent with the grant flags (one action per true flag)", () => {
    const pipeline = buildReviewPipelineCatalog();
    for (const member of pipeline.members) {
      if (!member.grants || !member.grantedActions) continue;
      const flags = Object.values(member.grants).filter(Boolean).length;
      expect(member.grantedActions).toHaveLength(flags);
      // Every granted action must itself be a registered syscall.
      const registered = new Set(SYSCALL_DEFINITIONS.map(definition => definition.action));
      for (const action of member.grantedActions) expect(registered.has(action as never)).toBe(true);
    }
  });

  it("marks evidenceWrite as granted ONLY for the Security profile", () => {
    const pipeline = buildReviewPipelineCatalog();
    const membersWithEvidenceWrite = pipeline.members.filter(member => member.grants?.evidenceWrite === true);
    expect(membersWithEvidenceWrite.map(member => member.key)).toEqual(["Security"]);
  });

  it("carries NO capability profile for the deterministic analyzer (none exists in source)", () => {
    const analyzer = buildReviewPipelineCatalog().members[0];
    expect(analyzer?.kind).toBe("deterministic-analyzer");
    expect(analyzer).not.toHaveProperty("capabilityProfile");
    expect(analyzer).not.toHaveProperty("grants");
    expect(analyzer).not.toHaveProperty("grantedActions");
  });

  it("pins context budgets to the exact constants used by prompt/context builders", () => {
    const budgets = buildReviewPipelineCatalog().budgets;
    expect(budgets.diffMaxChars).toBe(REVIEW_DIFF_MAX_CHARS);
    expect(budgets.fileContentsMaxChars).toBe(REVIEW_FILE_CONTENTS_MAX_CHARS);
    expect(budgets.projectMetadataMaxChars).toBe(REVIEW_PROJECT_METADATA_MAX_CHARS);
    expect(budgets.kernelEvidenceMaxEntries).toBe(REVIEW_KERNEL_EVIDENCE_MAX_ENTRIES);
    // Literal pins catch a silent double-edit of both constant and projection.
    expect(budgets.diffMaxChars).toBe(80_000);
    expect(budgets.fileContentsMaxChars).toBe(140_000);
    expect(budgets.projectMetadataMaxChars).toBe(30_000);
    expect(budgets.kernelEvidenceMaxEntries).toBe(40);
  });

  it("lists the ContextVM page kinds with their residency exactly as built", () => {
    expect(buildReviewPipelineCatalog().contextPages).toEqual([
      { kind: "policy", residency: "pinned" },
      { kind: "task", residency: "pinned" },
      { kind: "diff", residency: "pinned" },
      { kind: "source", residency: "hot" },
      { kind: "evidence", residency: "hot" }
    ]);
  });

  it("enumerates exactly the reviewPlanSchema fields", () => {
    expect(buildReviewPipelineCatalog().planFields).toEqual(["enabledAgents", "skippedAgents", "riskAreas", "reason"]);
  });
});

describe("buildKernelSyscallCatalog", () => {
  it("projects the syscall registry in full, order-preserving equality", () => {
    const catalog = buildKernelSyscallCatalog();
    expect(catalog.syscalls).toHaveLength(SYSCALL_DEFINITIONS.length);
    expect(catalog.syscalls).toEqual(
      SYSCALL_DEFINITIONS.map(definition => ({
        action: definition.action,
        effectClass: definition.effect,
        dispatchPolicy: definition.dispatch,
        ...(definition.description === undefined ? {} : { description: definition.description })
      }))
    );
  });

  it("flags exactly repo.write and github.publish as commit/intent actions", () => {
    const catalog = buildKernelSyscallCatalog();
    expect(catalog.commitIntentActions).toEqual(["repo.write", "github.publish"]);
    const byAction = new Map(catalog.syscalls.map(syscall => [syscall.action, syscall]));
    expect(byAction.get("repo.write")).toMatchObject({ effectClass: "commit", dispatchPolicy: "intent" });
    expect(byAction.get("github.publish")).toMatchObject({ effectClass: "commit", dispatchPolicy: "intent" });
  });

  it("covers every distinct effect/dispatch combination present in source exactly once", () => {
    const catalog = buildKernelSyscallCatalog();
    const combos = new Set(catalog.syscalls.map(syscall => `${syscall.effectClass}/${syscall.dispatchPolicy}`));
    expect(combos).toEqual(new Set(["pure/direct", "read/direct", "revertible/direct", "commit/direct", "commit/intent"]));
  });
});

describe("buildEngineAllowlistCatalog", () => {
  it("projects the zod enum allowlists verbatim", () => {
    const catalog = buildEngineAllowlistCatalog([]);
    expect(catalog.analyzers).toEqual([...analyzerKindSchema.options]);
    expect(catalog.verifiers).toEqual([...verifierKindSchema.options]);
    expect(catalog.analyzers).toHaveLength(10);
    expect(catalog.verifiers).toHaveLength(4);
  });

  it("derives runtime verification from a receipt callback, defaulting to unverified", () => {
    const fresh = buildEngineAllowlistCatalog([]).runtimeVerifiedBuiltins;
    expect(fresh.every(item => item.verificationStatus === "unverified" && item.status === "available")).toBe(true);
    const verified = buildEngineAllowlistCatalog([], { runtimeVerification: id => id === "pr-review" }).runtimeVerifiedBuiltins;
    expect(verified.find(item => item.id === "pr-review")?.verificationStatus).toBe("verified");
    expect(verified.find(item => item.id === "security-hardening")?.verificationStatus).toBe("unverified");
  });

  it("reports builtin workflows verbatim and never invents entries", () => {
    const sample = [{ name: "pr-review", description: "d" }];
    expect(buildEngineAllowlistCatalog(sample).builtinWorkflows).toEqual(sample);
    expect(buildEngineAllowlistCatalog([]).builtinWorkflows).toEqual([]);
    expect(buildEngineAllowlistCatalog([])).not.toHaveProperty("builtinWorkflowsUnavailable");
  });
});

describe("GET /catalog/* routes", () => {
  const servers: ReturnType<typeof createApiServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    servers.length = 0;
  });

  async function startServer(options: CreateApiServerOptions): Promise<number> {
    const server = createApiServer(options);
    servers.push(server);
    return listen(server);
  }

  it("serves all three catalogs when unauthenticated access is enabled (no token configured)", async () => {
    const port = await startServer({ workflows: new WorkflowStore() });
    const pipeline = await getJson(port, "/catalog/review-pipeline");
    expect(pipeline.status).toBe(200);
    expect(pipeline.body).toMatchObject({ pipeline: { budgets: { diffMaxChars: 80_000 } } });

    const syscalls = await getJson(port, "/catalog/kernel-syscalls");
    expect(syscalls.status).toBe(200);
    expect((syscalls.body as { catalog: { syscalls: unknown[] } }).catalog.syscalls).toHaveLength(SYSCALL_DEFINITIONS.length);

    const allowlist = await getJson(port, "/catalog/engine-allowlist");
    expect(allowlist.status).toBe(200);
    const catalogBody = (allowlist.body as { catalog: { analyzers: string[]; builtinWorkflows: { name: string }[]; engineLegacyBuiltins: { name: string }[]; runtimeVerifiedBuiltins: { id: string; namespace: string; checksum: string; verificationStatus: string; status: string }[]; builtinWorkflowsUnavailable?: boolean } }).catalog;
    expect(catalogBody.builtinWorkflowsUnavailable).toBeUndefined();
    // The repository ships exactly five builtin engine workflows.
    expect(catalogBody.builtinWorkflows.map(workflow => workflow.name).sort()).toEqual([
      "architectural-drift",
      "pr-review",
      "pr-sanity-verification",
      "security-hardening",
      "vibe-safety"
    ]);
    expect(catalogBody.engineLegacyBuiltins).toEqual(catalogBody.builtinWorkflows);
    expect(catalogBody.runtimeVerifiedBuiltins.map(workflow => workflow.id)).toEqual([
      "architectural-drift", "pr-review", "pr-sanity-verification", "security-hardening", "vibe-safety"
    ]);
    expect(catalogBody.runtimeVerifiedBuiltins.every(workflow => workflow.namespace === "workflow-runtime" && workflow.verificationStatus === "unverified" && workflow.status === "available" && /^[0-9a-f]{64}$/.test(workflow.checksum))).toBe(true);
    expect(catalogBody.analyzers.length).toBeGreaterThan(0);
  }, 30_000);

  it("reports builtin workflow names as unavailable (never guessed) without a workflows store", async () => {
    const port = await startServer({});
    const allowlist = await getJson(port, "/catalog/engine-allowlist");
    expect(allowlist.status).toBe(200);
    const catalogBody = (allowlist.body as { catalog: { builtinWorkflows: unknown[]; builtinWorkflowsUnavailable?: boolean } }).catalog;
    expect(catalogBody.builtinWorkflows).toEqual([]);
    expect(catalogBody.builtinWorkflowsUnavailable).toBe(true);
  }, 30_000);

  it("is strictly GET-only: mutating methods never match a catalog route", async () => {
    const port = await startServer({ workflows: new WorkflowStore() });
    const posted = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/catalog/review-pipeline", method: "POST" }, res => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({}));
    });
    expect([404, 405]).toContain(posted.status);
  }, 30_000);

  it("leaks no absolute paths, tokens, or handles in any catalog payload", async () => {
    const port = await startServer({ workflows: new WorkflowStore() });
    for (const path of ["/catalog/review-pipeline", "/catalog/kernel-syscalls", "/catalog/engine-allowlist"]) {
      const response = await getJson(port, path);
      expect(response.status).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/[A-Za-z]:\\\\/);
      expect(text).not.toMatch(/\/home\//);
      expect(text).not.toMatch(/\/Users\//);
      expect(text.toLowerCase()).not.toContain("bearer");
      expect(text).not.toMatch(/"(authorization|apikey|api_key|token|password|handle)":/i);
    }
  }, 30_000);
});
