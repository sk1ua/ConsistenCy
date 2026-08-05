import type { HeartbeatPulse } from "@consistency/schema";
import { Activity, GitBranch, FileWarning, Flame, Radar, ShieldAlert, Layers, TrendingDown, TrendingUp } from "lucide-react";
import { motion } from "framer-motion";
import { useI18n } from "../i18n";

function Sparkline({ values }: { values: number[] }) {
  const width = 220;
  const height = 42;
  if (values.length < 2) {
    return <svg className="heartbeat-sparkline" width={width} height={height} role="img" aria-label="risk index history" />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.001);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * (width - 4) + 2;
    const y = height - 3 - ((value - min) / span) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg className="heartbeat-sparkline" width={width} height={height} role="img" aria-label="risk index history">
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function heartbeatStateLabel(state: HeartbeatPulse["state"]): string {
  switch (state) {
    case "idle": return "Idle";
    case "scanning": return "Scanning";
    case "indexing": return "Indexing";
    case "degraded": return "Degraded";
    case "stopped": return "Stopped";
  }
}

export function HeartbeatWidget({ pulse, history, unavailable }: { pulse: HeartbeatPulse | null; history: HeartbeatPulse[]; unavailable: boolean }) {
  const { t } = useI18n();

  if (unavailable) {
    return <section className="section-block heartbeat-card">
      <div className="panel-title"><div><span className="panel-kicker"><Radar size={14} />{t("Live project status")}</span><h2>{t("Heartbeat is disabled")}</h2></div></div>
      <p className="heartbeat-hint">{t("Enable CONSISTENCY_HEARTBEAT_ENABLED=true to stream live repository pulses.")}</p>
    </section>;
  }

  if (!pulse) {
    return <section className="section-block heartbeat-card">
      <div className="panel-title"><div><span className="panel-kicker"><Radar size={14} />{t("Live project status")}</span><h2>{t("Waiting for the first pulse")}</h2></div><span className="heartbeat-live"><motion.span className="heartbeat-live-dot" animate={{ scale: [1, 1.7, 1], opacity: [1, 0.35, 1] }} transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }} />{t("Live")}</span></div>
      <p className="heartbeat-hint">{t("The heartbeat daemon will publish its first pulse within one interval.")}</p>
    </section>;
  }

  const trend = pulse.metrics?.riskIndexTrend ?? 0;
  const riskHistory = history
    .map(item => item.metrics?.riskIndex)
    .filter((value): value is number => value !== undefined);
  const metrics = [
    { label: t("Branch"), value: pulse.repository.branch ?? t("detached"), icon: GitBranch },
    { label: t("Dirty files"), value: String(pulse.dirtyFileCount), icon: FileWarning },
    { label: t("Churn"), value: pulse.metrics === undefined ? "-" : `${Math.round(pulse.metrics.churnRate)}/d`, icon: Flame },
    { label: t("Risk index"), value: pulse.metrics === undefined ? "-" : (pulse.metrics.riskIndex * 100).toFixed(0), icon: trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Activity },
    { label: t("Unsettled debt"), value: pulse.metrics === undefined ? "-" : String(pulse.metrics.unsettledSecurityDebt), icon: ShieldAlert },
    { label: t("Files tracked"), value: pulse.metrics === undefined ? "-" : String(pulse.metrics.filesTracked), icon: Layers }
  ] as const;

  return <section className="section-block heartbeat-card">
    <div className="panel-title">
      <div><span className="panel-kicker"><Radar size={14} />{t("Live project status")}</span><h2>{t("Repository pulse")}</h2></div>
      <span className={`heartbeat-state heartbeat-state-${pulse.state}`}><i />{t(heartbeatStateLabel(pulse.state))}</span>
    </div>
    <div className="heartbeat-metrics">
      {metrics.map(({ label, value, icon: Icon }) => <div className="heartbeat-metric" key={label}>
        <Icon size={15} /><span>{label}</span><strong>{value}</strong>
      </div>)}
    </div>
    {pulse.metrics && <div className="heartbeat-trend">
      <div><span>{t("Risk index trend")}</span><strong className={trend > 0 ? "trend-up" : trend < 0 ? "trend-down" : ""}>{trend > 0 ? "▲" : trend < 0 ? "▼" : "◆"} {Math.abs(trend * 100).toFixed(0)}%</strong></div>
      <Sparkline values={riskHistory} />
    </div>}
    <small className="heartbeat-observed">{t("Observed")} {new Date(pulse.observedAt).toLocaleTimeString()}</small>
  </section>;
}
