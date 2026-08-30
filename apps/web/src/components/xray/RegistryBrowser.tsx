import { AlertOctagon, ShieldCheck, Workflow } from "lucide-react";
import type { EngineAllowlistCatalog, KernelSyscallCatalog } from "@consistency/schema";
import { useI18n } from "../../i18n";

/**
 * Tools & capability registry browser (R3). Presents the Kernel syscall
 * registry (grouped by effectClass / dispatchPolicy, commit+intent emphasized)
 * and the engine analyzer/verifier allowlist with the builtin workflow library.
 * Everything rendered comes verbatim from the backend catalog endpoints (R1).
 */

const EFFECT_CLASS_ORDER = ["pure", "read", "revertible", "commit"] as const;

function effectClassLabel(effectClass: string): string {
  switch (effectClass) {
    case "pure": return "pure";
    case "read": return "read";
    case "revertible": return "revertible";
    default: return "commit";
  }
}

// Commit-class syscalls are irreversible external mutations, so the effect
// class chip escalates muted (no side effects) -> warn (revertible) -> danger.
function effectClassChipVariant(effectClass: string): string {
  switch (effectClass) {
    case "revertible": return "ds-chip--warn";
    case "commit": return "ds-chip--danger";
    default: return "ds-chip--muted";
  }
}

export function RegistryBrowser({
  syscalls,
  allowlist
}: {
  syscalls: KernelSyscallCatalog;
  allowlist?: EngineAllowlistCatalog;
}) {
  const { t } = useI18n();
  const commitIntentActions = new Set(syscalls.commitIntentActions);

  const grouped = EFFECT_CLASS_ORDER.map(effectClass => ({
    effectClass,
    rows: syscalls.syscalls.filter(row => row.effectClass === effectClass)
  })).filter(group => group.rows.length > 0);

  return (
    <div className="page-stack registry-browser" data-testid="registry-browser">
      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker"><ShieldCheck size={14} />{t("Kernel syscall registry")}</span>
            <h2 className="ds-section-title">{t("Every action an agent can ask the Kernel to perform")}</h2>
          </div>
          <div className="ds-section-actions">
            <strong className="ds-chip ds-chip--muted">{syscalls.syscalls.length}</strong>
          </div>
        </div>
        <p className="muted-note">
          {t("Rows marked “CommitCoordinator intent only” are irreversible external mutations; SyscallGateway hard-denies dispatching them inline.")}
        </p>
        <div className="workflow-runtime-inputs xray-syscall-groups">
          {grouped.map(group => (
            <div key={group.effectClass}>
              <h3 className="xray-group-heading">
                <span className="ds-section-kicker">{t("Effect class")}:</span>
                <span className={`ds-chip ${effectClassChipVariant(group.effectClass)}`}>{t(effectClassLabel(group.effectClass))}</span>
              </h3>
              <ul className="xray-list" role="list">
                {group.rows.map(row => {
                  const intent = row.dispatchPolicy === "intent";
                  return (
                    <li
                      key={row.action}
                      role="listitem"
                      className={`xray-row${intent ? " xray-intent-row" : ""}`}
                      data-testid={`syscall-${row.action}`}
                    >
                      <code>{row.action}</code>
                      <small>{row.description}</small>
                      <span className="ds-chip ds-chip--muted">{t("dispatch")}: {t(row.dispatchPolicy)}</span>
                      {intent && (
                        <span className="ds-chip ds-chip--warn"><AlertOctagon size={11} /> {t("CommitCoordinator intent only")}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {allowlist && (
        <section className="ds-section">
          <div className="ds-section-header">
            <div className="ds-section-heading">
              <span className="ds-section-kicker"><Workflow size={14} />{t("Engine step allowlist")}</span>
              <h2 className="ds-section-title">{t("Analyzer and verifier kinds the engine workflow schema accepts")}</h2>
            </div>
          </div>
          <h4 className="xray-subheading">{t("Analyzer kinds")} ({allowlist.analyzers.length})</h4>
          <div className="ds-chip-row" role="list">
            {allowlist.analyzers.map(kind => (
              <span className="ds-chip ds-chip--muted" role="listitem" key={kind}><code>{kind}</code></span>
            ))}
          </div>
          <h4 className="xray-subheading">{t("Verifier kinds")} ({allowlist.verifiers.length})</h4>
          <div className="ds-chip-row" role="list">
            {allowlist.verifiers.map(kind => (
              <span className="ds-chip ds-chip--muted" role="listitem" key={kind}><code>{kind}</code></span>
            ))}
          </div>

          <h4 className="xray-subheading">{t("Builtin engine workflow library")}</h4>
          {allowlist.builtinWorkflowsUnavailable ? (
            <div className="route-query-notice" role="alert">
              <strong>{t("Builtin workflow names unavailable")}</strong>
              <span>{t("The workflow store did not report builtin workflows; nothing is guessed here.")}</span>
            </div>
          ) : allowlist.builtinWorkflows.length === 0 ? (
            <div className="empty-inline-compact">{t("No builtin engine workflows reported (empty, not unavailable).")}</div>
          ) : (
            <ul className="xray-list" role="list">
              {allowlist.builtinWorkflows.map(workflow => (
                <li className="xray-row" role="listitem" key={workflow.name} data-testid={`builtin-workflow-${workflow.name}`}>
                  <strong>{workflow.name}</strong>
                  <small>{workflow.description ?? ""}</small>
                  <span className="ds-chip ds-chip--muted">{t("Builtin")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="muted-note">{t("This catalog is a projection of source code registries served by the API; the UI never maintains its own copy.")}</p>
    </div>
  );
}
