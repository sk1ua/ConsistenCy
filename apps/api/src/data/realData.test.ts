import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { importRealData, loadRealData } from "./realData";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "consistency-real-data-"));
  directories.push(root);
  mkdirSync(join(root, "evaluation", "results"), { recursive: true });
  writeFileSync(join(root, "evaluation", "results", "report.json"), JSON.stringify({
    base_ref: "base-sha-123", head_ref: "head-sha-456", commit_count: 1, avg_risk: 0.2, max_risk: 0.4,
    commits: [{ sha: "abcdef1", date: "2026-01-01T00:00:00Z", author: "dev", message: "change", risk_score: 0.2, risk_level: "Consistent", files_analyzed: 2 }],
    top_risky_files: [{ file: "src/app.ts", avg_risk: 0.4, max_risk: 0.4, hits: 1 }],
    risk_composition: { components_avg: { semantic: 0.3 } }
  }));
  writeFileSync(join(root, "evaluation", "results", "metrics_summary.json"), JSON.stringify({
    sample_count: 10, evaluated_count: 1, k: 3, mean_precision_at_k: 0.5, mean_recall_at_k: 0.25,
    samples: [{ repo: "owner/repo", pr_number: 7, predicted_top_files: ["src/app.ts"], gold_top_files: ["src/app.ts", "src/test.ts"], precision_at_k: 0.5, recall_at_k: 0.25 }]
  }));
  writeFileSync(join(root, "evaluation", "sampled_prs.json"), JSON.stringify([{ repo: "owner/repo", pr_number: 7, label_source: "public_review_comments", needs_manual_audit: true, source_dataset: "public/sample", annotations: [{ overall_risk: "medium", top_risky_files: ["src/app.ts"] }] }]));
  const pull = { number: 7, state: "closed", title: "Real PR", html_url: "https://github.com/owner/repo/pull/7", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", merged_at: "2026-01-02T00:00:00Z", commits: 1, changed_files: 2, additions: 10, deletions: 4, user: { login: "dev" }, base: { sha: "base-sha-123" }, head: { sha: "head-sha-456" } };
  return { root, pull };
}

describe("real data import", () => {
  it("verifies GitHub facts against the local analysis before persisting", async () => {
    const { root, pull } = fixture();
    const snapshot = await importRealData({
      rootDirectory: root, repository: "owner/repo", pullRequestNumber: 7, reportPath: "evaluation/results/report.json",
      fetchJson: async url => url.endsWith("/reviews") ? [{ state: "COMMENTED" }] : pull
    });

    expect(snapshot.source).toMatchObject({ commits: 1, changedFiles: 2, additions: 10, deletions: 4, reviewCount: 1 });
    expect(snapshot.analysis.commits).toHaveLength(1);
    expect(loadRealData(root)?.validation.needsManualAudit).toBe(true);
    expect(readFileSync(join(root, ".consistency", "real-data.json"), "utf8")).not.toContain("secret");
  });

  it("rejects a report whose head SHA differs from GitHub", async () => {
    const { root, pull } = fixture();
    await expect(importRealData({
      rootDirectory: root, repository: "owner/repo", pullRequestNumber: 7, reportPath: "evaluation/results/report.json",
      fetchJson: async url => url.endsWith("/reviews") ? [] : { ...pull, head: { sha: "different-sha" } }
    })).rejects.toThrow("SHA values do not match");
  });
});
