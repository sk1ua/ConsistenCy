import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PRReviewContext, ReviewFinding } from "@consistency/schema";
import { RepositorySnapshot } from "@consistency/repository";
import { ReviewWorkload, type ModelDriver } from "../index.js";
import { cleanupTmpDirs, git, makeDeterministicStage, makeFixtureRepo, TestModelDriver, TestPersistence } from "./fixtures.js";

afterEach(cleanupTmpDirs);

// OFFLINE prompt/grounding/pipeline regression with injected known findings.
// The Python source is never executed. This does not measure live-model recall.
const cases = [
  {
    name: "shell injection", before: "import subprocess", after: "import subprocess",
    safe: 'subprocess.run(["echo", request.query["name"]], check=True)',
    unsafe: 'subprocess.run("echo " + request.query["name"], shell=True, check=True)',
    trigger: "An untrusted HTTP client supplies shell metacharacters in the name query parameter",
    evidence: "The request query is concatenated into a command at line 4 and passed to shell=True without escaping.",
    remediation: "Restore the previous argument-list API and keep shell=False.",
  },
  {
    name: "unsafe deserialization", before: "import json", after: "import pickle",
    safe: "json.loads(request.body)", unsafe: "pickle.loads(request.body)",
    trigger: "An untrusted HTTP client supplies a crafted pickle payload in the request body",
    evidence: "Line 4 passes the raw network request body directly to pickle.loads, which can invoke attacker-controlled reducers.",
    remediation: "Restore the previous safe JSON parser; never deserialize untrusted input with pickle.",
  },
];

describe("Security scope and retention", () => {
  it.each(cases)("retains a grounded Security finding for introduced $name while preserving the specialist cap", async scenario => {
    const repo = makeFixtureRepo();
    const file = "src/handler.py";
    const source = (header: string, call: string) => `${header}\n\ndef handle_network_request(request):\n    return ${call}\n`;
    const base = source(scenario.before, scenario.safe);
    const head = source(scenario.after, scenario.unsafe);
    fs.writeFileSync(path.join(repo.repoPath, file), base, "utf8");
    git(repo.repoPath, ["add", file]);
    git(repo.repoPath, ["commit", "-q", "-m", "safe request handler"]);
    const baseSha = git(repo.repoPath, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo.repoPath, file), head, "utf8");
    git(repo.repoPath, ["add", file]);
    git(repo.repoPath, ["commit", "-q", "-m", "changed request handler"]);
    const headSha = git(repo.repoPath, ["rev-parse", "HEAD"]);
    const diff = git(repo.repoPath, ["diff", baseSha, headSha, "--", file]);
    const context: PRReviewContext = {
      ...repo.context, baseSha, headSha,
      changedFiles: [{ path: file, status: "modified", additions: 2, deletions: 2, changes: 4, patch: diff }],
      diff, fileContents: { [file]: head }, baseFileContents: { [file]: base },
    };
    const finding: ReviewFinding = {
      id: "security-introduced", agent: "Security", title: `Introduced ${scenario.name}`,
      severity: "high", confidence: "confirmed", file, startLine: 4, endLine: 4,
      evidence: scenario.evidence, reasoning: "The changed sink crosses the network-input trust boundary without an effective guard.",
      trigger: scenario.trigger, recommendation: scenario.remediation,
    };
    const inner = new TestModelDriver({
      plan: { enabledAgents: ["Security"], skippedAgents: [], riskAreas: ["network input"], reason: "Changed request sink", focusAreas: [] },
      findingsByAgent: { Security: [finding] },
    });
    let summaryCalls = 0;
    const driver: ModelDriver = {
      provider: inner.provider, model: inner.model,
      invokeStructured: request => inner.invokeStructured(request),
      invokeAgentFindings: async request => {
        expect(request.agent).toBe("Security");
        expect(request.userPrompt).toContain(scenario.unsafe);
        expect(request.userPrompt).toContain("source-to-dangerous-sink");
        expect(request.userPrompt).toContain("do not require executing an exploit or defer the vulnerability to Correctness");
        expect(request.userPrompt).toContain("Return at most 3 findings");
        expect(request.systemPrompt).toContain("remediate an introduced vulnerability is not a mere revert preference");
        return inner.invokeAgentFindings(request);
      },
      invokeSummary: async request => {
        summaryCalls += 1;
        expect(request.systemPrompt).toContain("Do not penalize a real introduced vulnerability");
        expect(JSON.parse(request.userPrompt).findings).toHaveLength(1);
        return { data: { summary: "Protect the changed network-input boundary.", scores: [{ id: finding.id, score: 9, reason: "Visible untrusted source reaching an unsafe changed sink" }] } };
      },
    };
    const snapshot = RepositorySnapshot.create({ repositoryPath: repo.repoPath, repository: context.repositoryFullName, baseSha, headSha });
    const result = await new ReviewWorkload({
      snapshot, context, modelDriver: driver,
      deterministic: makeDeterministicStage({ analyzeFiles: [{ path: file, riskScore: 0, riskLabel: "Stable", riskColor: "GREEN", confidence: 1, signals: {}, findings: [] }] }),
      persistence: new TestPersistence(), reportLanguage: "en-US", publicationPolicy: "disabled", accessMode: "local_git",
    }).run();
    expect(summaryCalls).toBe(1);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]).toMatchObject({ agent: "Security", file, startLine: 4, score: 9 });
    expect(result.report.preExistingIssues ?? []).toHaveLength(0);
    expect(result.report.filteredFindingCount ?? 0).toBe(0);
    expect(result.report.agentRuns.find(run => run.agentName === "Security")).toMatchObject({ status: "succeeded" });
  });
});
