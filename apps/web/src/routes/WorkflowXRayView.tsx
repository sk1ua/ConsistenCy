import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScanSearch } from "lucide-react";
import type { ReviewJob } from "@consistency/schema";
import { api } from "../api/client";
import { workspaceQueryKeys } from "../query/client";
import { useI18n } from "../i18n";
import { AgentPipelineXRay, type RunAgentStatusOverlay } from "../components/xray/AgentPipelineXRay";
import { RegistryBrowser } from "../components/xray/RegistryBrowser";
import { WorkflowRuntimeRunOverlay } from "../components/xray/WorkflowRuntimeRunOverlay";

/**
 * Read-only "Agent X-Ray" tab (R2 + R3 + CKPT6 Phase 4). Three catalog queries
 * with honest per-section failure states — a failing section degrades alone
 * and NEVER falls back to a client-side copy. The optional run overlay derives
 * per-agent statuses from an existing review job's report agentRuns; planner
 * decision fields are not published by any API surface today and surface as
 * unavailable. A separate read-only section overlays workflow runtime runs
 * (per definition-node states from a finished run's miniReport); the runtime
 * node vocabulary is never mapped onto the LLM review pipeline members.
 */

export function WorkflowXRayView({ jobs }: { jobs: ReviewJob[] }) {
  const { t } = useI18n();
  const [overlayJobId, setOverlayJobId] = useState<string>("");

  const pipelineQuery = useQuery({
    queryKey: workspaceQueryKeys.catalogReviewPipeline,
    queryFn: ({ signal }) => api.reviewPipelineCatalog(signal),
    retry: false
  });
  const syscallsQuery = useQuery({
    queryKey: workspaceQueryKeys.catalogKernelSyscalls,
    queryFn: ({ signal }) => api.kernelSyscallCatalog(signal),
    retry: false
  });
  const allowlistQuery = useQuery({
    queryKey: workspaceQueryKeys.catalogEngineAllowlist,
    queryFn: ({ signal }) => api.engineAllowlistCatalog(signal),
    retry: false
  });

  // Jobs that already carry a parsed report with recorded AgentRuns.
  const overlayCandidates = useMemo(
    () => jobs.filter(job => job.report?.agentRuns && job.report.agentRuns.length > 0),
    [jobs]
  );
  const overlay = useMemo<RunAgentStatusOverlay | undefined>(() => {
    const job = overlayCandidates.find(candidate => candidate.id === overlayJobId);
    if (!job?.report) return undefined;
    const statusByAgentName: Record<string, string> = {};
    for (const agentRun of job.report.agentRuns) {
      statusByAgentName[agentRun.agentName] = agentRun.status;
    }
    return { jobLabel: `${job.repositoryFullName} · ${job.id}`, statusByAgentName };
  }, [overlayCandidates, overlayJobId]);

  const catalogUnavailable =
    pipelineQuery.isError && syscallsQuery.isError && allowlistQuery.isError;
  if (catalogUnavailable) {
    return (
      <div className="route-query-notice" role="alert" data-testid="xray-catalog-unavailable">
        <strong>{t("Catalog endpoints unavailable")}</strong>
        <span>{t("The API did not serve the read-only catalogs. This view renders no locally cached substitute.")}</span>
      </div>
    );
  }

  return (
    <div className="page-stack workflow-xray-view">
      <section className="ds-hero">
        <div className="ds-hero-icon"><ScanSearch size={18} /></div>
        <div className="ds-hero-body">
          <h2 className="ds-hero-title">{t("Why an agent ran, what it saw, and where evidence came from")}</h2>
          <p className="ds-hero-description">{t("This view is read-only. Agent subsetting is decided by the runtime LLM planner inside each run; nothing on this page can enable, disable, or edit a pipeline stage.")}</p>
        </div>
        <div className="ds-hero-actions">
          <span className="ds-chip ds-chip--muted">{t("Read-only inspection")}</span>
          {overlayCandidates.length > 0 && (
            <label className="workflow-check xray-overlay-picker">
              <span>{t("Overlay run")}</span>
              <select
                className="ds-select"
                aria-label={t("Overlay run")}
                value={overlayJobId}
                onChange={event => setOverlayJobId(event.target.value)}
              >
                <option value="">{t("No run selected")}</option>
                {overlayCandidates.map(job => (
                  <option key={job.id} value={job.id}>{job.repositoryFullName} · {job.id}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      {pipelineQuery.isPending ? (
        <div className="empty-inline-compact">{t("Loading pipeline catalog…")}</div>
      ) : pipelineQuery.isError ? (
        <div className="route-query-notice" role="alert" data-testid="xray-pipeline-error">
          <strong>{t("Pipeline catalog unavailable")}</strong>
          <span>{t("The API did not serve the review pipeline projection; this section stays empty instead of guessing.")}</span>
        </div>
      ) : (
        pipelineQuery.data && <AgentPipelineXRay pipeline={pipelineQuery.data.pipeline} runOverlay={overlay} />
      )}
      {overlayJobId !== "" && (
        <p className="muted-note" data-testid="xray-plan-availability">
          {t("Planner enable/skip lists and plan reason are not published by the current API; only recorded AgentRun statuses are overlaid.")}
        </p>
      )}

      <WorkflowRuntimeRunOverlay />

      {syscallsQuery.isPending ? (
        <div className="empty-inline-compact">{t("Loading syscall registry…")}</div>
      ) : syscallsQuery.isError ? (
        <div className="route-query-notice" role="alert" data-testid="xray-syscalls-error">
          <strong>{t("Syscall registry unavailable")}</strong>
          <span>{t("The API did not serve the Kernel syscall projection; this section stays empty instead of guessing.")}</span>
        </div>
      ) : (
        syscallsQuery.data && (
          <RegistryBrowser
            syscalls={syscallsQuery.data.catalog}
            allowlist={allowlistQuery.isError || !allowlistQuery.data ? undefined : allowlistQuery.data.catalog}
          />
        )
      )}
      {syscallsQuery.data && allowlistQuery.isError && (
        <div className="route-query-notice" role="alert" data-testid="xray-allowlist-error">
          <strong>{t("Engine allowlist unavailable")}</strong>
          <span>{t("The API did not serve the engine allowlist projection; this section stays empty instead of guessing.")}</span>
        </div>
      )}
    </div>
  );
}
