import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { workspaceQueryKeys } from "../../query/client";
import { useI18n } from "../../i18n";

/**
 * Read-only "workflow runtime run" overlay for the Agent X-Ray (CKPT6 Phase 4).
 *
 * Honesty contract: the workflow runtime publishes per-node execution state
 * ONLY in a finished run's miniReport (`agents[]` keyed by the definition's
 * node ids). That vocabulary belongs to the workflow runtime chain and is
 * deliberately NOT the LLM review pipeline's agent names, so this section
 * never maps runtime node states onto pipeline members — the two chains are
 * never conflated. Every rendered value comes from the API; a section that
 * fails or is empty says so instead of guessing.
 */

export function WorkflowRuntimeRunOverlay() {
  const { t } = useI18n();
  const [runId, setRunId] = useState("");

  const runsQuery = useQuery({
    queryKey: workspaceQueryKeys.workflowRuntimeRuns,
    queryFn: ({ signal }) => api.workflowRuntimeRuns(20, signal),
    retry: false
  });

  const runQuery = useQuery({
    queryKey: workspaceQueryKeys.workflowRuntimeRun(runId),
    queryFn: ({ signal }) => api.workflowRuntimeRunV2(runId, signal),
    enabled: runId !== "",
    retry: false
  });

  const runs = runsQuery.data ?? [];
  const run = runId === "" ? undefined : runQuery.data;

  return (
    <section className="ds-section" data-testid="xray-runtime-run-overlay">
      <div className="ds-section-header">
        <div className="ds-section-heading">
          <span className="ds-section-kicker">{t("Workflow runtime runs")}</span>
          <h2 className="ds-section-title">{t("Workflow runtime execution, node by node")}</h2>
        </div>
        {runs.length > 0 && (
          <label className="workflow-check xray-overlay-picker">
            <span>{t("Overlay workflow runtime run")}</span>
            <select
              className="ds-select"
              aria-label={t("Overlay workflow runtime run")}
              value={runId}
              onChange={event => setRunId(event.target.value)}
            >
              <option value="">{t("No run selected")}</option>
              {runs.map(candidate => (
                <option key={candidate.runId} value={candidate.runId}>
                  {candidate.repository} @ {candidate.headSha.slice(0, 12)} · {candidate.definitionId} · {candidate.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {runsQuery.isPending ? (
        <div className="empty-inline-compact">{t("Loading workflow runtime runs…")}</div>
      ) : runsQuery.isError ? (
        <div className="route-query-notice" role="alert" data-testid="xray-runtime-runs-error">
          <strong>{t("Workflow runtime run history unavailable")}</strong>
          <span>{t("The API did not serve the workflow runtime run history; this section stays empty instead of guessing.")}</span>
        </div>
      ) : runs.length === 0 ? (
        <div className="ds-empty">
          <span className="ds-empty-text">{t("No workflow runtime runs yet (empty, not unavailable).")}</span>
        </div>
      ) : runId === "" ? (
        undefined
      ) : runQuery.isPending ? (
        <div className="empty-inline-compact">{t("Loading run detail…")}</div>
      ) : runQuery.isError ? (
        <div className="route-query-notice" role="alert" data-testid="xray-runtime-run-error">
          <strong>{t("Run detail unavailable")}</strong>
          <span>{t("The API did not serve this run; the section shows no substitute.")}</span>
        </div>
      ) : run ? (
        <div className="workflow-runtime-result" data-testid="xray-runtime-run-detail">
          <div className="trigger-status-item">
            <span>
              {t("Run status")}: {run.status} · {run.definitionId} · {run.revisionId}
              {` · ${run.origin}`}
            </span>
          </div>
          <div className="trigger-status-item">
            <span>{run.snapshot.repository} @ {run.snapshot.headSha.slice(0, 12)}</span>
          </div>
          {run.trigger && (
            <div className="trigger-status-item">
              <span>
                {run.trigger.source === "repository_change" ? t("Change-triggered") : t("Manual")}
                {run.trigger.eventId ? ` · ${run.trigger.eventId.slice(0, 24)}…` : ""}
              </span>
            </div>
          )}
          {run.miniReport && (
            <div className="trigger-status-item">
              <span>
                {t("Kernel audit")}: {run.miniReport.audit.allowed} {t("allowed")} · {run.miniReport.audit.denied} {t("denied")}
              </span>
            </div>
          )}
          {run.miniReport && run.miniReport.agents.length > 0 && (
            <>
              <h4 className="xray-subheading">{t("Recorded node executions")}</h4>
              <ul className="workflow-runtime-errors xray-budgets">
                {run.miniReport.agents.map(agent => (
                  <li key={`${agent.nodeId}-${agent.agentId}`}>
                    <code>{agent.nodeId}</code> ({agent.agentId}) — {agent.state} · fiberApplied {agent.fiberApplied}
                  </li>
                ))}
              </ul>
              <p className="muted-note">
                {t("Node ids use the definition vocabulary of the workflow runtime, not the LLM review pipeline agent names; the two chains are never conflated here.")}
              </p>
            </>
          )}
          {!run.miniReport && (
            <p className="muted-note">
              {t("The per-node report is written when the run finishes; this run exposes no per-node state yet.")}
            </p>
          )}
          {run.error && <p className="muted-note">{run.error}</p>}
        </div>
      ) : undefined}
    </section>
  );
}
