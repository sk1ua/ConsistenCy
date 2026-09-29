/**
 * PR-4 end-to-end deterministic slice (§49):
 *
 *   temporary Git repo → commit SHA → RepositorySnapshot
 *   → TreeSitterService → Style/Secret analyzers → EvidenceStore
 *   → Evidence → ContextPage(kind="evidence") → ContextManager render
 *
 * No LLM, no Cordis, no review workflow. The repository SHA must survive
 * end-to-end, fingerprints must be deterministic, and rendered context must
 * trace back to evidence provenance.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ContextManager, EvidenceStore, computeEvidenceFingerprint } from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import {
  SecretAnalyzer,
  StyleAnalyzer,
  TreeSitterService,
  type AnalyzerDeps,
  type AnalyzerInput,
} from "../index.js";

const TMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const FAKE_TOKEN = `ghp_${"B".repeat(36)}`; // synthetic

describe("PR-4 end-to-end deterministic slice", () => {
  it("snapshot → analyzers → evidence → context, with SHA preserved end-to-end", async () => {
    // 1. Temporary Git repository with one commit.
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-e2e-"));
    TMP_DIRS.push(repoPath);
    git(repoPath, ["init", "-q"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "src", "index.ts"),
      [
        "export function risky(a1: number, a2: number, a3: number, a4: number, a5: number, a6: number) {}",
        `export const token = "${FAKE_TOKEN}";  `, // synthetic secret + trailing whitespace
        "export const fine = 1;",
      ].join("\n"),
      "utf8",
    );
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-q", "-m", "initial"]);
    const headSha = git(repoPath, ["rev-parse", "HEAD"]);

    // 2. Immutable snapshot.
    const snapshot = RepositorySnapshot.create({
      repositoryPath: repoPath,
      repository: "test/example",
      headSha,
    });

    // 3. Infrastructure + analyzers.
    const treeSitter = new TreeSitterService();
    const deps: AnalyzerDeps = {
      readFile: async (filePath: string) => {
        const file = snapshot.readFile(filePath);
        return { path: file.path, content: file.content };
      },
      treeSitter,
    };
    const input: AnalyzerInput = {
      repository: "test/example",
      headSha: snapshot.identity().headSha,
      files: snapshot.listFiles(),
    };

    const style = new StyleAnalyzer();
    const secret = new SecretAnalyzer();
    const runAnalyzers = async () => [
      ...(await style.analyze(input, deps)),
      ...(await secret.analyze(input, deps)),
    ];

    const run1 = await runAnalyzers();
    const run2 = await runAnalyzers();
    expect(run1.length).toBeGreaterThanOrEqual(3); // trailing ws + params + secret
    expect(run1.map(computeEvidenceFingerprint)).toEqual(run2.map(computeEvidenceFingerprint));

    // 4. Kernel Evidence store.
    const store = new EvidenceStore();
    const records = run1.map((evidenceInput) => store.add(evidenceInput));
    for (const record of records) {
      expect(record.provenance.sha).toBe(headSha); // SHA preserved end-to-end
    }
    expect(store.query({ sha: headSha })).toHaveLength(records.length);
    // No raw secret anywhere in the store.
    expect(JSON.stringify(store.list())).not.toContain(FAKE_TOKEN);

    // 5. Evidence → ContextPage(kind="evidence") → render.
    const contexts = new ContextManager();
    const imageId = contexts.createImage();
    for (const record of store.list()) {
      const pageId = contexts.createPage({
        kind: "evidence",
        text: JSON.stringify({
          ruleId: record.ruleId ?? record.source,
          source: record.source,
          location: record.location,
          fingerprint: record.fingerprint,
        }),
        estimatedTokens: 64,
        provenance: {
          repository: record.provenance.repository,
          sha: record.provenance.sha,
          producer: record.provenance.analyzer,
          producerVersion: record.provenance.analyzerVersion,
        },
      });
      contexts.attach(imageId, pageId, "hot");
    }

    const rendered = contexts.render(imageId);
    expect(rendered.pages.length).toBe(records.length);
    for (const page of rendered.pages) {
      // Rendered context traces back to evidence provenance + fingerprint.
      expect(page.provenance.sha).toBe(headSha);
      const fingerprint = (JSON.parse(page.text) as { fingerprint: string }).fingerprint;
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(store.list().some((r) => r.fingerprint === fingerprint)).toBe(true);
    }

    // 6. Working-tree mutation AFTER the snapshot must not change the run.
    fs.writeFileSync(path.join(repoPath, "src", "index.ts"), "// hacked\n", "utf8");
    const run3 = await runAnalyzers();
    expect(run3.map(computeEvidenceFingerprint)).toEqual(run1.map(computeEvidenceFingerprint));
  });
});
