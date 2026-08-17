import type { HeartbeatPulse, StatsResponse } from "@consistency/schema";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mockJobs, mockReports, mockStats } from "../demo/mockReports";
import { I18nProvider } from "../i18n";
import { buildInboxModel, DashboardPage } from "./DashboardPage";

const emptyStats: StatsResponse = {
  totalJobs: 0,
  succeededJobs: 0,
  failedJobs: 0,
  runningJobs: 0,
  averageDuration: 0,
  riskDistribution: { critical: 0, high: 0, medium: 0, low: 0 },
  topRepositories: []
};

const pulse: HeartbeatPulse = {
  pulseId: "pulse-dashboard-test",
  state: "degraded",
  repository: { root: "ConsistenCy", provider: "local_git", branch: "main", headSha: "abcdef0" },
  observedAt: "2026-08-14T12:00:00.000Z",
  dirtyFileCount: 2,
  pendingEvents: 1,
  lastIndexedSha: "abcdef0",
  lastError: "Index refresh is delayed",
  metrics: {
    windowDays: 14,
    churnRate: 12,
    riskIndex: 0.72,
    riskIndexTrend: 0.2,
    unsettledSecurityDebt: 3,
    filesTracked: 420,
    computedAt: "2026-08-14T12:00:00.000Z"
  }
};

function renderDashboard({
  stats = mockStats,
  jobs = mockJobs,
  reports = mockReports,
  heartbeat
}: {
  stats?: StatsResponse;
  jobs?: typeof mockJobs;
  reports?: typeof mockReports;
  heartbeat?: { pulse: HeartbeatPulse | null; history: HeartbeatPulse[]; unavailable: boolean };
} = {}): string {
  return renderToString(<I18nProvider initialLocale="en-US"><DashboardPage
    stats={stats}
    jobs={jobs}
    reports={reports}
    onOpenJob={() => undefined}
    onOpenJobs={() => undefined}
    onAnalyzePublicPr={async () => undefined}
    publicPrAccessMode="anonymous"
    heartbeat={heartbeat}
  /></I18nProvider>);
}

describe("DashboardPage operations inbox", () => {
  it("derives one prioritized model without inventing decisions or automation history", () => {
    const model = buildInboxModel(mockJobs, mockReports);

    expect(model.decisions).toHaveLength(5);
    expect(model.decisions[0]?.report.riskLevel).toBe("high");
    expect(model.activeRuns.map(job => job.status).sort()).toEqual(["queued", "running"]);
    expect(model.degradedRuns.map(job => job.status)).toEqual(["failed"]);
    expect(model.repositories).toHaveLength(8);
    expect(model.recentJobs.length).toBeLessThanOrEqual(6);
  });

  it("puts actionable queues and live status ahead of decorative dashboard content", () => {
    const html = renderDashboard({ heartbeat: { pulse, history: [pulse], unavailable: false } });
    const text = html.replaceAll("<!-- -->", "");

    expect(text).toContain("Operations inbox");
    expect(text).toContain("Decision queue");
    expect(text).toContain("acme/payments-api");
    expect(text).toContain("Run watch");
    expect(text).toContain("Repository fleet");
    expect(text).toContain("Repository risk index worsened +20%");
    expect(text).toContain("Inbox does not receive automation execution history");
    expect(text).toContain("Recent reviews");
    expect(text).not.toContain("Focus attention where the evidence is strongest");
    expect(text).not.toContain("Review workflow");
    expect(text).not.toContain("metric-card");
  });

  it("renders explicit source-aware empty states", () => {
    const html = renderDashboard({ stats: emptyStats, jobs: [], reports: [], heartbeat: { pulse: null, history: [], unavailable: false } });

    expect(html).toContain("No completed analyses are waiting for a recorded decision");
    expect(html).toContain("No active or degraded runs are recorded");
    expect(html).toContain("No repository has produced a review or heartbeat yet");
    expect(html).toContain("repository health history is unavailable");
    expect(html).toContain("automation execution history");
    expect(html).toContain("No review runs have been recorded");
  });
});
