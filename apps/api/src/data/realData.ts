import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { findProjectRoot } from "../config/settings";

const githubPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
  html_url: z.string().url(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  merged_at: z.string().datetime().nullable(),
  commits: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  user: z.object({ login: z.string() }),
  base: z.object({ sha: z.string().min(7) }),
  head: z.object({ sha: z.string().min(7) })
});

const legacyReportSchema = z.object({
  base_ref: z.string().min(7),
  head_ref: z.string().min(7),
  commit_count: z.number().int().nonnegative(),
  avg_risk: z.number().min(0).max(1),
  max_risk: z.number().min(0).max(1),
  commits: z.array(z.object({
    sha: z.string().min(7),
    date: z.string(),
    author: z.string(),
    message: z.string(),
    risk_score: z.number().min(0).max(1),
    risk_level: z.string(),
    files_analyzed: z.number().int().nonnegative()
  }).passthrough()),
  top_risky_files: z.array(z.object({
    file: z.string(),
    avg_risk: z.number().min(0).max(1),
    max_risk: z.number().min(0).max(1),
    hits: z.number().int().nonnegative(),
    churn_lines: z.number().nonnegative().optional(),
    complexity: z.number().nonnegative().optional(),
    owner: z.string().optional()
  }).passthrough()),
  risk_composition: z.object({
    components_avg: z.record(z.number()).default({}),
    formula: z.string().optional()
  }).passthrough().optional()
}).passthrough();

const metricsSchema = z.object({
  sample_count: z.number().int().nonnegative(),
  evaluated_count: z.number().int().nonnegative(),
  k: z.number().int().positive(),
  mean_precision_at_k: z.number().min(0).max(1),
  mean_recall_at_k: z.number().min(0).max(1),
  samples: z.array(z.object({
    repo: z.string(),
    pr_number: z.number().int().positive(),
    predicted_top_files: z.array(z.string()),
    gold_top_files: z.array(z.string()),
    precision_at_k: z.number().min(0).max(1),
    recall_at_k: z.number().min(0).max(1)
  }))
});

const manifestSchema = z.array(z.object({
  repo: z.string(),
  pr_number: z.number().int().positive(),
  label_source: z.string().optional(),
  needs_manual_audit: z.boolean().optional(),
  source_dataset: z.string().optional(),
  annotations: z.array(z.object({ overall_risk: z.string(), top_risky_files: z.array(z.string()) }).passthrough()).optional()
}).passthrough());

export const realDataSnapshotSchema = z.object({
  version: z.literal(1),
  importedAt: z.string().datetime(),
  source: z.object({
    provider: z.literal("github"), repository: z.string(), pullRequestNumber: z.number().int().positive(), url: z.string().url(),
    fetchedAt: z.string().datetime(), title: z.string(), author: z.string(), state: z.string(), createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(), mergedAt: z.string().datetime().nullable(), baseSha: z.string(), headSha: z.string(),
    commits: z.number().int().nonnegative(), changedFiles: z.number().int().nonnegative(), additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(), reviewCount: z.number().int().nonnegative()
  }),
  analysis: z.object({
    reportPath: z.string(), generatedAt: z.string().datetime(), method: z.string(), commitCount: z.number().int().nonnegative(),
    averageRisk: z.number().min(0).max(1), maxRisk: z.number().min(0).max(1), riskScale: z.literal("0-1"),
    commits: legacyReportSchema.shape.commits,
    topRiskyFiles: legacyReportSchema.shape.top_risky_files,
    components: z.record(z.number())
  }),
  validation: z.object({
    sourceDataset: z.string(), labelSource: z.string(), needsManualAudit: z.boolean(), sampleCount: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(), k: z.number().int().positive(), precisionAtK: z.number().min(0).max(1),
    recallAtK: z.number().min(0).max(1), goldOverallRisk: z.string(), predictedTopFiles: z.array(z.string()), goldTopFiles: z.array(z.string())
  })
}).strict();

export type RealDataSnapshot = z.infer<typeof realDataSnapshotSchema>;

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function inside(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }

export async function importRealData(options: {
  rootDirectory?: string;
  repository?: string;
  pullRequestNumber?: number;
  reportPath?: string;
  fetchJson?: (url: string) => Promise<unknown>;
} = {}): Promise<RealDataSnapshot> {
  const root = resolve(options.rootDirectory ?? findProjectRoot());
  const repository = options.repository ?? "espnet/espnet";
  const pullRequestNumber = options.pullRequestNumber ?? 6327;
  const reportPath = resolve(root, options.reportPath ?? "evaluation/results/espnet__espnet_pr6327_report.json");
  if (!inside(root, reportPath) || !existsSync(reportPath)) throw new Error("Real-data report must exist inside the workspace");

  const getJson = options.fetchJson ?? (async (url: string) => {
    const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "ConsistenCy-real-data-import" } });
    if (!response.ok) throw new Error(`GitHub request failed with ${response.status}`);
    return response.json();
  });
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const pullUrl = `https://api.github.com/repos/${encodedRepository}/pulls/${pullRequestNumber}`;
  const [pullInput, reviewsInput] = await Promise.all([getJson(pullUrl), getJson(`${pullUrl}/reviews`)]);
  const pull = githubPullSchema.parse(pullInput);
  const reviews = z.array(z.unknown()).parse(reviewsInput);
  const report = legacyReportSchema.parse(readJson(reportPath));
  const metrics = metricsSchema.parse(readJson(join(root, "evaluation/results/metrics_summary.json")));
  const manifest = manifestSchema.parse(readJson(join(root, "evaluation/sampled_prs.json")));
  const metric = metrics.samples.find(item => item.repo === repository && item.pr_number === pullRequestNumber);
  const sample = manifest.find(item => item.repo === repository && item.pr_number === pullRequestNumber);
  if (!metric || !sample) throw new Error("Validation metadata is missing for the selected pull request");
  if (pull.base.sha !== report.base_ref || pull.head.sha !== report.head_ref) throw new Error("GitHub SHA values do not match the analysis report");
  if (pull.commits !== report.commit_count || report.commits.length !== report.commit_count) throw new Error("GitHub commit count does not match the analysis report");

  const now = new Date().toISOString();
  const snapshot: RealDataSnapshot = realDataSnapshotSchema.parse({
    version: 1,
    importedAt: now,
    source: {
      provider: "github", repository, pullRequestNumber, url: pull.html_url, fetchedAt: now, title: pull.title,
      author: pull.user.login, state: pull.state, createdAt: pull.created_at, updatedAt: pull.updated_at, mergedAt: pull.merged_at,
      baseSha: pull.base.sha, headSha: pull.head.sha, commits: pull.commits, changedFiles: pull.changed_files,
      additions: pull.additions, deletions: pull.deletions, reviewCount: reviews.length
    },
    analysis: {
      reportPath: relative(root, reportPath).replaceAll("\\", "/"), generatedAt: statSync(reportPath).mtime.toISOString(),
      method: "ConsistenCy deterministic risk pipeline", commitCount: report.commit_count, averageRisk: report.avg_risk,
      maxRisk: report.max_risk, riskScale: "0-1", commits: report.commits, topRiskyFiles: report.top_risky_files.slice(0, 8),
      components: report.risk_composition?.components_avg ?? {}
    },
    validation: {
      sourceDataset: sample.source_dataset ?? "foundry-ai/swe-prbench", labelSource: sample.label_source ?? "public_review_comments",
      needsManualAudit: sample.needs_manual_audit ?? true, sampleCount: metrics.sample_count, evaluatedCount: metrics.evaluated_count,
      k: metrics.k, precisionAtK: metric.precision_at_k, recallAtK: metric.recall_at_k,
      goldOverallRisk: sample.annotations?.[0]?.overall_risk ?? "unknown", predictedTopFiles: metric.predicted_top_files,
      goldTopFiles: metric.gold_top_files
    }
  });
  const outputPath = join(root, ".consistency", "real-data.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, outputPath);
  return snapshot;
}

export function loadRealData(rootDirectory = findProjectRoot()): RealDataSnapshot | undefined {
  const path = join(resolve(rootDirectory), ".consistency", "real-data.json");
  return existsSync(path) ? realDataSnapshotSchema.parse(readJson(path)) : undefined;
}
