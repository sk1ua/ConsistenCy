import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, GitBranch, LoaderCircle, PlayCircle, X } from "lucide-react";
import type { Repository, WorkflowRuntimeDefinitionSummary, WorkflowRuntimeRunV2 } from "@consistency/schema";
import { ApiRequestError, api } from "../api/client";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";

/**
 * Main-line review wizard shell (R4). A thin choreography over EXISTING
 * surfaces: repository connection stays on the Repositories page (its own
 * connect modal), definition selection reads the canonical definitions API,
 * binding uses the same PUT the repository Workflows view uses, and running
 * polls run detail with the same bounded loop (300 ms × 200) every other
 * surface uses. Readiness is never judged locally — the backend refuses
 * drafts/unavailable snapshots and those refusals are surfaced verbatim.
 */

export type WizardStep = "repository" | "definition" | "trigger" | "run";

/** Per-error-code localization, mirroring publicRepositoryErrorMessage. */
export function wizardErrorMessage(error: unknown, zh: boolean): string | undefined {
  if (!error) return undefined;
  const code = error instanceof ApiRequestError ? error.code : undefined;
  const messages: Record<string, [string, string]> = {
    REPOSITORY_NOT_FOUND: ["The repository is no longer registered. Pick another one.", "该仓库已不再注册。请选择其他仓库。"],
    WORKFLOW_DEFINITION_NOT_FOUND: ["The workflow definition was deleted. Go back and pick another.", "工作流定义已被删除。请返回并重新选择。"],
    WORKFLOW_DEFINITION_NOT_EXECUTABLE: ["This revision cannot execute yet (not validated). Save a validated revision first.", "该 revision 尚不可执行（未通过校验）。请先保存可通过校验的 revision。"],
    WORKFLOW_SNAPSHOT_UNAVAILABLE: ["The repository HEAD snapshot is unavailable right now. Try again later.", "仓库 HEAD 快照当前不可用。请稍后重试。"],
    WORKFLOW_RUNTIME_STORE_UNAVAILABLE: ["Workflow runtime persistence is unavailable.", "工作流运行时持久化不可用。"],
    BINDING_CONFLICT: ["This definition already has a different binding on this repository.", "该定义在此仓库上已存在冲突的绑定。"]
  };
  const message = code === undefined ? undefined : messages[code];
  if (message) return message[zh ? 1 : 0];
  return error instanceof Error ? error.message : zh ? "操作失败，请重试。" : "The operation failed. Try again.";
}

export const VERIFIED_MINI_REVIEW_ID = "verified-mini-review";

export function ReviewWizardDialog({
  repositories,
  onClose,
  desktopBridgeAvailable = false
}: {
  repositories: Repository[];
  onClose: () => void;
  desktopBridgeAvailable?: boolean;
}) {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<WizardStep>("repository");
  const [repositoryId, setRepositoryId] = useState<string>(repositories.find(repo => repo.source === "local_git")?.id ?? repositories[0]?.id ?? "");
  const [definitionId, setDefinitionId] = useState<string>("");
  const [triggerMode, setTriggerMode] = useState<"manual" | "on_change">("manual");
  const [actionError, setActionError] = useState<string>();
  const [run, setRun] = useState<WorkflowRuntimeRunV2 | null>(null);
  const [pollNotice, setPollNotice] = useState<string>();

  const modalRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  /**
   * Poll cancellation flag: flipped to false on unmount so an in-flight poll
   * stops issuing requests and never touches state after the dialog closed.
   * Re-armed in the effect body so React StrictMode's dev double-mount
   * (mount → cleanup → mount) cannot leave it permanently disabled.
   */
  const pollActiveRef = useRef(true);
  const definitionsCacheKey = ["workflow-runtime-definitions"];

  // Reuse the SAME query key the RepositoryWorkflowsView caches under.
  const cachedDefinitions = queryClient.getQueryData<WorkflowRuntimeDefinitionSummary[]>(definitionsCacheKey);
  const [definitions, setDefinitions] = useState<WorkflowRuntimeDefinitionSummary[] | null>(cachedDefinitions ?? null);
  const [definitionsUnavailable, setDefinitionsUnavailable] = useState(false);

  useEffect(() => {
    if (definitions !== null) return;
    let cancelled = false;
    api.workflowRuntimeDefinitions().then(result => {
      if (!cancelled) setDefinitions(result);
    }).catch(() => {
      if (!cancelled) setDefinitionsUnavailable(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Focus management follows the existing dialog conventions: record the
    // trigger (document.activeElement) on open, focus the modal, and return
    // focus to the trigger on close/unmount (design-system/Dialog.tsx).
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    modalRef.current?.focus();
    pollActiveRef.current = true;
    return () => {
      pollActiveRef.current = false;
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  async function invalidateBindingSurfaces() {
    await queryClient.invalidateQueries({ queryKey: ["workflow-runtime-bindings", repositoryId] });
    await queryClient.invalidateQueries({ queryKey: ["workflow-runtime-repo-runs", repositoryId] });
  }

  const bindAndPrepareRun = useMutation({
    mutationFn: async () => {
      await api.setWorkflowRuntimeBinding(repositoryId, definitionId, true, triggerMode);
      await invalidateBindingSurfaces();
      const created = await api.triggerWorkflowRuntimeForRepository(repositoryId, definitionId);
      return created;
    },
    onSuccess: async created => {
      if (!pollActiveRef.current) return;
      setActionError(undefined);
      setStep("run");
      try {
        await pollRun(created.runId);
      } catch (error) {
        if (pollActiveRef.current) setActionError(wizardErrorMessage(error, zh));
      }
    },
    onError: (error: unknown) => {
      if (pollActiveRef.current) setActionError(wizardErrorMessage(error, zh));
    }
  });

  async function pollRun(runId: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      // Stop before issuing another request once the dialog has closed.
      if (!pollActiveRef.current) return;
      const current = await api.workflowRuntimeRunV2(runId);
      // Stop before any state update once the dialog has closed.
      if (!pollActiveRef.current) return;
      setRun(current);
      if (current.status !== "running") {
        await invalidateBindingSurfaces();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!pollActiveRef.current) return;
    setPollNotice(t("Timed out waiting for the run to finish"));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Focus trap: Tab/Shift+Tab cycle inside the modal (same discipline as the
    // Repositories connect modal — last focusable wraps to the first and back).
    if (event.key !== "Tab") return;
    const focusable = [
      ...(modalRef.current?.querySelectorAll<HTMLElement>(
        "input, select, textarea, button:not([disabled]), [tabindex='0']"
      ) ?? [])
    ].filter(el => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  const selectedDefinition = definitions?.find(candidate => candidate.definitionId === definitionId);
  const selectedRepository = repositories.find(candidate => candidate.id === repositoryId);
  const executable = selectedDefinition?.status === "validated";

  const stepLabels: Record<WizardStep, string> = {
    repository: t("1 · Connect a repository"),
    definition: t("2 · Pick a verified workflow"),
    trigger: t("3 · Bind the trigger"),
    run: t("4 · Run")
  };

  return (
    <div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={modalRef}
        className="modal-card review-wizard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-wizard-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <div>
            <span className="panel-kicker"><GitBranch size={13} />{t("Review wizard")}</span>
            <h3 id="review-wizard-title">{t("From connected repository to finished run")}</h3>
          </div>
          <button type="button" className="drawer-close-btn" aria-label={t("Close")} onClick={onClose}><X size={16} /></button>
        </div>

        <ol className="wizard-steps" aria-label={t("Wizard steps")}>
          {(Object.keys(stepLabels) as WizardStep[]).map(key => (
            <li key={key} className={`wizard-step ${step === key ? "active" : ""}`} aria-current={step === key ? "step" : undefined}>
              {stepLabels[key]}
            </li>
          ))}
        </ol>

        <div className="modal-body">
          {step === "repository" && (
            <section aria-label={stepLabels.repository}>
              {repositories.length === 0 ? (
                <>
                  <p className="muted-note">{t("No registered repository yet. Connection happens on the Repositories page.")}</p>
                  {!desktopBridgeAvailable && (
                    <p className="muted-note">{t("Local folder registration is available in the desktop app; browser users connect a public GitHub repository there.")}</p>
                  )}
                  <Button variant="primary" type="button" onClick={() => { onClose(); navigate("/repositories"); }}>
                    {t("Open the Repositories page")}
                  </Button>
                </>
              ) : (
                <label>
                  {t("Repository")}
                  <select className="ds-select" aria-label={t("Repository")} value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>
                    {repositories.map(repository => (
                      <option key={repository.id} value={repository.id}>
                        {repository.displayName} ({repository.source === "local_git" ? t("local") : repository.source})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
          )}

          {step === "definition" && (
            <section aria-label={stepLabels.definition}>
              {definitionsUnavailable ? (
                <div className="route-query-notice" role="alert">
                  <strong>{t("Definitions unavailable")}</strong>
                  <span>{t("The definition library could not be loaded. Nothing is guessed here.")}</span>
                </div>
              ) : definitions === null ? (
                <div className="empty-inline-compact">{t("Loading definition library…")}</div>
              ) : definitions.length === 0 ? (
                <div className="empty-inline-compact">{t("No persisted definitions yet (empty, not unavailable). They appear after API startup seeds the builtin library.")}</div>
              ) : (
                <div className="automation-list" role="list">
                  {definitions.map(definition => {
                    const highlighted = definition.definitionId === VERIFIED_MINI_REVIEW_ID;
                    return (
                      <label
                        key={definition.definitionId}
                        role="listitem"
                        className={`automation-row ${definitionId === definition.definitionId ? "xray-intent-row" : ""}`}
                      >
                        <input
                          type="radio"
                          name="wizard-definition"
                          value={definition.definitionId}
                          checked={definitionId === definition.definitionId}
                          onChange={() => setDefinitionId(definition.definitionId)}
                        />
                        <span>
                          <strong>{definition.definitionId}</strong>{" "}
                          {highlighted && <span className="provenance-pill xray-pill-accent">{t("verified · runs without LLM")}</span>}
                          <small>
                            {" "}· {definition.origin === "builtin" ? t("Builtin") : t("user")}
                            {definition.latestRevision !== null ? ` · r${definition.latestRevision} ${definition.status === "validated" ? "✓" : "!"}` : ""}
                          </small>
                          {highlighted && (
                            <em className="muted-note xray-hint">{t("The builtin deterministic pipeline: real evidence from your pinned snapshot, zero model calls.")}</em>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {step === "trigger" && (
            <section aria-label={stepLabels.trigger}>
              <p className="muted-note">
                {t("Bound to")}: <strong>{selectedRepository?.displayName ?? repositoryId}</strong> · <strong>{definitionId}</strong>
              </p>
              <label>
                {t("Trigger mode")}
                <select className="ds-select" aria-label={t("Trigger mode")} value={triggerMode} onChange={event => setTriggerMode(event.target.value as "manual" | "on_change")}>
                  <option value="manual">{t("Manual")}</option>
                  <option value="on_change">{t("On change")}</option>
                </select>
              </label>
              <p className="muted-note">
                {triggerMode === "on_change"
                  ? t("Repository change events will start this workflow automatically (at most once per event, pinned to the HEAD at that time).")
                  : t("You start each run yourself after binding.")}
              </p>
              {!executable && (
                <div className="route-query-notice" role="alert">
                  <strong>{t("Latest revision is not validated")}</strong>
                  <span>{t("The backend refuses unexecutable revisions; switching to a validated definition avoids the failure.")}</span>
                </div>
              )}
            </section>
          )}

          {step === "run" && (
            <section aria-label={stepLabels.run}>
              {!run ? (
                <div className="empty-inline-compact"><LoaderCircle size={14} className="spinning" /> {t("Running…")}</div>
              ) : (
                <>
                  <p>
                    <CheckCircle2 size={14} className={run.status === "succeeded" ? "icon-success" : ""} />{" "}
                    <strong>{t("Run status")}: {run.status}</strong> · {run.evidence.length} {t("Evidence records")}
                  </p>
                  <p className="muted-note">{run.snapshot.repository} @ {run.snapshot.headSha.slice(0, 12)}</p>
                  {run.error && <p className="muted-note">{run.error}</p>}
                  <Button variant="primary" type="button" onClick={() => { onClose(); navigate("/workflows?tab=runtime"); }}>
                    <PlayCircle size={14} />{t("Open run in Verified runtime")}
                  </Button>
                </>
              )}
            </section>
          )}

          {actionError && <div className="route-query-notice" role="alert"><strong>{t("Action refused (fail-closed)")}</strong><span>{actionError}</span></div>}
          {bindAndPrepareRun.isPending && <div className="empty-inline-compact"><LoaderCircle size={13} className="spin" /> {t("Binding and starting…")}</div>}
          {pollNotice && <div className="route-query-notice" role="status"><span>{pollNotice}</span></div>}
        </div>

        <div className="modal-footer wizard-footer">
          {step !== "repository" && step !== "run" && (
            <Button variant="ghost" type="button" disabled={bindAndPrepareRun.isPending} onClick={() => setStep(step === "trigger" ? "definition" : "repository")}>
              {t("Back")}
            </Button>
          )}
          {step === "repository" && (
            <Button variant="primary" type="button" disabled={repositories.length === 0 || !repositoryId} onClick={() => setStep("definition")}>
              {t("Next")}
            </Button>
          )}
          {step === "definition" && (
            <Button variant="primary" type="button" disabled={!definitionId} onClick={() => setStep("trigger")}>
              {t("Next")}
            </Button>
          )}
          {step === "trigger" && (
            <Button variant="primary" type="button" disabled={!repositoryId || !definitionId || bindAndPrepareRun.isPending} onClick={() => bindAndPrepareRun.mutate()}>
              <PlayCircle size={14} />{t("Bind and run")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
