import { useMemo, useState } from "react";
import { BrainCircuit, Cpu, FileSearch, Layers } from "lucide-react";
import type { ReviewPipelineCatalog, ReviewPipelineMember } from "@consistency/schema";
import { useI18n } from "../../i18n";

/**
 * Read-only review pipeline X-Ray (R2). Renders the agent pipeline exactly as
 * projected by the backend catalog (R1): DeterministicAnalyzer → Planner →
 * six specialized agents → Synthesizer. There are NO configuration controls —
 * the runtime LLM planner owns agent subsetting; this surface only explains.
 */

export type RunAgentStatusOverlay = {
  /** Human-readable label of the inspected run (job id). */
  jobLabel: string;
  /** agentName → AgentRun status for recorded runs only; absent = no record. */
  statusByAgentName: Record<string, string>;
};

function memberBadgeKey(kind: ReviewPipelineMember["kind"]): string {
  switch (kind) {
    case "deterministic-analyzer": return "Deterministic";
    case "planner": return "Planner";
    case "specialized-agent": return "Agent";
    case "synthesizer": return "Synthesizer";
  }
}

function AgentNode({
  member,
  selected,
  overlayStatus,
  onSelect
}: {
  member: ReviewPipelineMember;
  selected: boolean;
  overlayStatus?: string;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const icon =
    member.kind === "deterministic-analyzer" ? <FileSearch size={14} /> :
    member.kind === "planner" ? <BrainCircuit size={14} /> :
    member.kind === "synthesizer" ? <Layers size={14} /> : <Cpu size={14} />;
  return (
    <button
      type="button"
      className={`xray-node${selected ? " xray-node--active" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
      data-testid={`xray-node-${member.key}`}
    >
      <span className="xray-node-head">
        {icon}
        <strong>{member.key}</strong>
      </span>
      <span className="xray-node-meta">
        <span className="ds-chip ds-chip--muted">{t(memberBadgeKey(member.kind))}</span>
        {member.grantedActions?.includes("evidence.write") === true && (
          <span className="ds-chip ds-chip--warn">{t("evidence write")}</span>
        )}
        {overlayStatus && <span className="ds-chip ds-chip--muted">{t("Run")}: {overlayStatus}</span>}
      </span>
    </button>
  );
}

function MemberDetail({ member, pipeline }: { member: ReviewPipelineMember; pipeline: ReviewPipelineCatalog }) {
  const { t } = useI18n();
  const toolList = useMemo(() => {
    if (!member.capabilityProfile || !member.grants || !member.grantedActions) return undefined;
    return member.grantedActions.map(action => {
      // Surface the commit/intent class straight from the catalog projection.
      const registered = action === "repo.write" || action === "github.publish";
      return { action, intent: registered };
    });
  }, [member]);

  return (
    <section className="ds-section xray-detail" data-testid="xray-detail" aria-live="polite">
      <div className="ds-section-header">
        <div className="ds-section-heading">
          <span className="ds-section-kicker">{t("Agent detail")}</span>
          <h3 className="ds-section-title">{member.key}</h3>
        </div>
        {member.capabilityProfile && (
          <div className="ds-section-actions">
            <span className="ds-chip ds-chip--ok">{t("Capability profile")}: {member.capabilityProfile}</span>
          </div>
        )}
      </div>

      {/* Layer 1: context pages + budgets */}
      <h4 className="xray-subheading">{t("Context")}</h4>
      <div className="automation-triggers-summary">
        {pipeline.contextPages.map(page => (
          <div className="trigger-status-item" key={`${page.kind}-${page.residency}`}>
            <Layers size={13} />
            <span>
              {page.kind} ·{" "}
              {page.residency === "pinned" ? t("pinned") : t("hot")}
            </span>
          </div>
        ))}
      </div>
      <ul className="workflow-runtime-errors xray-budgets">
        <li>{t("Diff budget")}: ≤ {pipeline.budgets.diffMaxChars.toLocaleString()} {t("chars")}</li>
        <li>{t("File contents budget")}: ≤ {pipeline.budgets.fileContentsMaxChars.toLocaleString()} {t("chars")}</li>
        <li>{t("Project metadata budget")}: ≤ {pipeline.budgets.projectMetadataMaxChars.toLocaleString()} {t("chars")}</li>
        <li>{t("Kernel evidence budget")}: ≤ {pipeline.budgets.kernelEvidenceMaxEntries} {t("entries")}</li>
      </ul>

      {/* Layer 2: tools */}
      <h4 className="xray-subheading">{t("Tools")}</h4>
      {toolList === undefined ? (
        <div className="empty-inline-compact">
          {t("No capability profile is assigned to this stage in source, so no tool list exists.")}
        </div>
      ) : (
        <div className="automation-triggers-summary">
          {toolList.map(tool => (
            <div className="trigger-status-item" key={tool.action}>
              {tool.intent ? <ShieldIntentIcon /> : <Cpu size={13} />}
              <span><code>{tool.action}</code></span>
            </div>
          ))}
        </div>
      )}

      {/* Layer 3: supervisor plan semantics */}
      <h4 className="xray-subheading">{t("Planner decision fields")}</h4>
      {member.kind === "planner" ? (
        <>
          <p className="muted-note">{t("The supervisor plans WHICH agents run; KernelScheduler admission still decides what may run. The subset selection belongs to the runtime planner and is never configurable here.")}</p>
          <ul className="workflow-runtime-errors xray-budgets">
            {pipeline.planFields.map(field => <li key={field}><code>{field}</code></li>)}
          </ul>
        </>
      ) : (
        <p className="muted-note">{t("Not reported per run: planner enable/skip decisions live in the supervisor plan and are not published by any API surface yet.")}</p>
      )}
    </section>
  );
}

function ShieldIntentIcon() {
  return <span aria-hidden="true" className="xray-intent-dot" />;
}

export function AgentPipelineXRay({
  pipeline,
  runOverlay
}: {
  pipeline: ReviewPipelineCatalog;
  runOverlay?: RunAgentStatusOverlay;
}) {
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState<string>("Security");
  const planner = pipeline.members.find(member => member.kind === "planner");
  const agents = pipeline.members.filter(member => member.kind === "specialized-agent");
  const synthesizer = pipeline.members.find(member => member.kind === "synthesizer");
  const deterministic = pipeline.members.find(member => member.kind === "deterministic-analyzer");
  const selected = pipeline.members.find(member => member.key === selectedKey) ?? agents[0];

  if (!selected || !planner || !synthesizer || !deterministic) {
    return <div className="route-query-notice" role="alert"><strong>{t("Catalog shape unexpected")}</strong></div>;
  }

  const overlayFor = (member: ReviewPipelineMember): string | undefined =>
    runOverlay?.statusByAgentName[member.agentName ?? member.key];

  return (
    <div className="page-stack xray-view" data-testid="agent-pipeline-xray">
      {runOverlay && (
        <p className="muted-note">
          {t("Run overlay")}: {runOverlay.jobLabel} · {t("Missing entries mean the run recorded no AgentRun for that agent.")}
        </p>
      )}

      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker"><FileSearch size={14} />{t("Stage 1")}</span>
            <h2 className="ds-section-title">{t("Deterministic analysis before any LLM runs")}</h2>
          </div>
        </div>
        <div className="xray-node-row">
          <AgentNode
            member={deterministic}
            selected={selected.key === deterministic.key}
            overlayStatus={overlayFor(deterministic)}
            onSelect={() => setSelectedKey(deterministic.key)}
          />
        </div>
      </section>

      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker"><BrainCircuit size={14} />{t("Stage 2")}</span>
            <h2 className="ds-section-title">{t("Supervisor planning (LLM)")}</h2>
          </div>
        </div>
        <div className="xray-node-row">
          <AgentNode
            member={planner}
            selected={selected.key === planner.key}
            overlayStatus={overlayFor(planner)}
            onSelect={() => setSelectedKey(planner.key)}
          />
        </div>
      </section>

      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker"><Cpu size={14} />{t("Stage 3")}</span>
            <h2 className="ds-section-title">{t("Six specialized review agents")}</h2>
          </div>
        </div>
        <div className="xray-agent-grid" role="list">
          {agents.map(agent => (
            <AgentNode
              key={agent.key}
              member={agent}
              selected={selected.key === agent.key}
              overlayStatus={overlayFor(agent)}
              onSelect={() => setSelectedKey(agent.key)}
            />
          ))}
        </div>
      </section>

      <section className="ds-section">
        <div className="ds-section-header">
          <div className="ds-section-heading">
            <span className="ds-section-kicker"><Layers size={14} />{t("Stage 4")}</span>
            <h2 className="ds-section-title">{t("Synthesis")}</h2>
          </div>
        </div>
        <div className="xray-node-row">
          <AgentNode
            member={synthesizer}
            selected={selected.key === synthesizer.key}
            overlayStatus={overlayFor(synthesizer)}
            onSelect={() => setSelectedKey(synthesizer.key)}
          />
        </div>
      </section>

      <MemberDetail member={selected} pipeline={pipeline} />
    </div>
  );
}
