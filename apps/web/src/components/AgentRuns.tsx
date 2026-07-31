import type { AgentRun } from "@consistency/schema";
import { CheckCircle2, CircleSlash2, Clock3, XCircle } from "lucide-react";
import { useI18n } from "../i18n";

function duration(run: AgentRun, inProgress: string): string {
  if (!run.finishedAt) return inProgress;
  return `${Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())} ms`;
}

export function AgentRuns({ runs }: { runs: AgentRun[] }) {
  const { t } = useI18n();
  return <div className="agent-timeline">{runs.map(run => {
    const Icon = run.status === "succeeded" ? CheckCircle2 : run.status === "failed" ? XCircle : run.status === "skipped" ? CircleSlash2 : Clock3;
    return <div className={`agent-run agent-${run.status}`} key={run.id}>
      <Icon size={17} />
      <div><strong>{run.agentName}</strong><span>{run.inputSummary}</span></div>
      <div className="agent-meta"><strong>{run.findings.length}</strong><span>{t("findings")}</span></div>
      <div className="agent-meta"><strong>{duration(run, t("In progress"))}</strong><span>{t(run.status)}</span></div>
      {run.error && <p className="agent-error">{run.error}</p>}
    </div>;
  })}</div>;
}
