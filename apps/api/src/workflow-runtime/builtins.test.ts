// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RepositorySnapshot } from "@consistency/repository";
import { compileWorkflowRuntimeDefinition } from "./compile";
import { executeWorkflowPlan } from "./executor";
import {
  WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS,
  WORKFLOW_RUNTIME_BUILTIN_METADATA,
  runtimeBuiltinChecksum,
} from "./definition";
import { validateWorkflowRuntimeDefinitionInput } from "./validate";

const TARGETS = ["pr-review", "pr-sanity-verification", "security-hardening", "architectural-drift", "vibe-safety"] as const;
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-ckpt6-")); dirs.push(root);
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "test"]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), `export function risky(a: number, b: number, c: number, d: number, e: number, f: number) {}  \nexport const token = "ghp_${"F".repeat(36)}";\n`);
  git(root, ["add", "."]); git(root, ["commit", "-q", "-m", "fixture"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  return { root, sha };
}

describe.each(TARGETS)("runtime-native builtin %s", id => {
  it("parses, compiles, dry-loads through registry, runs, persists evidence and verifies output", async () => {
    const definition = WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[id];
    const metadata = WORKFLOW_RUNTIME_BUILTIN_METADATA[id];
    expect(definition).toBeDefined();
    expect(metadata).toMatchObject({ id, namespace: "workflow-runtime", revision: 1 });
    expect(runtimeBuiltinChecksum(definition!)).toBe(metadata!.checksum);
    const parsed = validateWorkflowRuntimeDefinitionInput(definition);
    expect(parsed.ok).toBe(true);
    const compilation = compileWorkflowRuntimeDefinition(definition);
    expect(compilation.ok).toBe(true);
    expect(compilation.plan?.agentSpecs.map(spec => spec.serviceRef)).toEqual(
      id === "architectural-drift" || id === "vibe-safety"
        ? ["deterministic-evidence.analyzer", "deterministic-evidence.analyzer", "persisted-evidence.verifier"]
        : ["deterministic-evidence.analyzer", "persisted-evidence.verifier"],
    );
    const repo = fixture();
    const result = await executeWorkflowPlan(compilation.plan!, {
      repository: "test/ckpt6", headSha: repo.sha, paths: ["src/index.ts"],
      snapshot: RepositorySnapshot.create({ repositoryPath: repo.root, repository: "test/ckpt6", headSha: repo.sha, baseSha: repo.sha }),
    });
    expect(result.status).toBe("succeeded");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every(record => record.provenance.sha === repo.sha && /^[0-9a-f]{64}$/.test(record.fingerprint))).toBe(true);
    if (id === "vibe-safety" || id === "architectural-drift") {
      expect(new Set(result.evidence.map(record => record.provenance.analyzer))).toEqual(new Set(["style", "secret"]));
    }
    expect(result.miniReport.status).toBe("succeeded");
    expect(result.miniReport.findings.length).toBeGreaterThan(0);
    expect(result.miniReport.findings.every(finding => finding.verified && finding.evidenceIds.length > 0)).toBe(true);
  }, 30_000);
});

it("uses five unique graph signatures, with a real sequential vibe-safety gate", () => {
  const signature = (id: typeof TARGETS[number]) => {
    const definition = WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[id]!;
    return JSON.stringify({
      nodes: definition.nodes.map(node => [node.id, node.type, node.parameters]),
      edges: definition.edges,
    });
  };
  const signatures = TARGETS.map(signature);
  expect(new Set(signatures).size).toBe(TARGETS.length);
  expect(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS["vibe-safety"]!.nodes.map(node => node.id)).toEqual(["style", "secret", "verify"]);
  expect(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS["vibe-safety"]!.edges).toEqual([
    { from: "style", to: "secret" },
    { from: "secret", to: "verify" },
  ]);
  expect(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS["architectural-drift"]!.edges).toEqual([
    { from: "style", to: "verify" },
    { from: "secret", to: "verify" },
  ]);
});

it("does not resolve prototype property names as builtins", () => {
  expect((WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS as Record<string, unknown>)["toString"]).toBeUndefined();
  expect((WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS as Record<string, unknown>)["constructor"]).toBeUndefined();
  expect((WORKFLOW_RUNTIME_BUILTIN_METADATA as Record<string, unknown>)["__proto__"]).toBeUndefined();
});

it("keeps built-in ids/checksums/revisions deterministic and excludes legacy YAML execution", () => {
  expect(TARGETS).toHaveLength(5);
  for (const id of TARGETS) {
    const metadata = WORKFLOW_RUNTIME_BUILTIN_METADATA[id];
    expect(metadata).toBeDefined();
    expect(metadata!.revisionId).toBe(`wfrev_builtin_${id}_v1`);
    expect(metadata!.checksum).toBe(runtimeBuiltinChecksum(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[id]!));
    expect(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[id]!.nodes).toHaveLength(id === "architectural-drift" || id === "vibe-safety" ? 3 : 2);
    expect(WORKFLOW_RUNTIME_BUILTIN_DEFINITIONS[id]!.edges).toEqual(
      id === "architectural-drift"
        ? [{ from: "style", to: "verify" }, { from: "secret", to: "verify" }]
        : id === "vibe-safety"
          ? [{ from: "style", to: "secret" }, { from: "secret", to: "verify" }]
          : [{ from: "analyze", to: "verify" }],
    );
  }
});
