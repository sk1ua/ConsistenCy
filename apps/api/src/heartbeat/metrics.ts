import type { RepoHealthMetrics, ReviewReport, Severity } from "@consistency/schema";

export type ChurnStats = {
  windowDays: number;
  commits: number;
  linesChanged: number;
  filesTouched: number;
};

/** Severities that count against the repository's outstanding security debt. */
const DEBT_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["critical", "high"]);

/**
 * Converts a quality score (0 best-risk at 100) into a 0..1 risk index.
 * Inverted so that every metric in the pulse reads "higher is worse".
 */
export function riskIndexFromScore(score: number): number {
  const bounded = Math.min(100, Math.max(0, score));
  return Number(((100 - bounded) / 100).toFixed(4));
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export type ReviewHistorySnapshot = {
  /** Mean risk index across the most recent reports, if any exist. */
  riskIndex?: number;
  /** Mean risk index across the reports immediately preceding those. */
  previousRiskIndex?: number;
  unsettledSecurityDebt: number;
};

/**
 * Derives a history snapshot from reports ordered newest-first.
 *
 * `unsettledSecurityDebt` counts critical and high findings in the *latest*
 * report only: an older report's findings were either fixed or restated by the
 * newer one, so summing across reports would double-count the same defect.
 */
export function summariseReviewHistory(
  reportsNewestFirst: readonly ReviewReport[],
  sampleSize = 5
): ReviewHistorySnapshot {
  const size = Math.max(1, sampleSize);
  const recent = reportsNewestFirst.slice(0, size);
  const previous = reportsNewestFirst.slice(size, size * 2);

  const latest = reportsNewestFirst[0];
  const unsettledSecurityDebt = latest === undefined
    ? 0
    : latest.findings.filter(finding => DEBT_SEVERITIES.has(finding.severity)).length;

  const snapshot: ReviewHistorySnapshot = { unsettledSecurityDebt };
  const riskIndex = mean(recent.map(report => riskIndexFromScore(report.score)));
  const previousRiskIndex = mean(previous.map(report => riskIndexFromScore(report.score)));
  if (riskIndex !== undefined) snapshot.riskIndex = Number(riskIndex.toFixed(4));
  if (previousRiskIndex !== undefined) snapshot.previousRiskIndex = Number(previousRiskIndex.toFixed(4));
  return snapshot;
}

export type HealthMetricsInput = {
  churn: ChurnStats;
  history: ReviewHistorySnapshot;
  filesTracked: number;
  computedAt: Date;
};

/**
 * Assembles the metrics block carried on a pulse.
 *
 * With no review history the risk index is 0 and the trend is flat — an
 * unreviewed repository is reported as unknown-but-not-alarming rather than
 * being assigned a fabricated score.
 */
export function computeHealthMetrics(input: HealthMetricsInput): RepoHealthMetrics {
  const { churn, history, filesTracked, computedAt } = input;
  const windowDays = Math.max(1, churn.windowDays);
  const riskIndex = history.riskIndex ?? 0;
  const previous = history.previousRiskIndex;
  const trend = previous === undefined ? 0 : riskIndex - previous;

  return {
    windowDays,
    churnRate: Number((churn.linesChanged / windowDays).toFixed(2)),
    riskIndex: Number(Math.min(1, Math.max(0, riskIndex)).toFixed(4)),
    riskIndexTrend: Number(Math.min(1, Math.max(-1, trend)).toFixed(4)),
    unsettledSecurityDebt: history.unsettledSecurityDebt,
    filesTracked,
    computedAt: computedAt.toISOString()
  };
}
