import type { ReviewFinding } from "@consistency/schema";
import { ChevronDown, FileCode2 } from "lucide-react";
import { useId, useState } from "react";
import { StatusBadge } from "./StatusBadge";
import { useI18n } from "../i18n";

export function FindingItem({ finding, onLocate }: { finding: ReviewFinding; onLocate?: (file: string, line: number | undefined) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const summaryId = `${detailId}-summary`;
  const line = finding.startLine === undefined
    ? t("File-level")
    : finding.startLine === finding.endLine ? `L${finding.startLine}` : `L${finding.startLine}-${finding.endLine}`;
  return (
    <article className="finding-item">
      <div className="finding-summary-row">
        <button
          id={summaryId}
          className="finding-summary"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded(value => !value)}
        >
          <FileCode2 size={17} />
          <span className="finding-title"><strong>{finding.title}</strong>{onLocate ? null : <small>{finding.file} / {line}</small>}</span>
          <span className="finding-badges">
            <StatusBadge value={finding.severity} />
            <StatusBadge value={finding.confidence} />
          </span>
          <ChevronDown className={expanded ? "rotated" : ""} size={17} />
        </button>
        {onLocate ? <button
          className="finding-locate"
          type="button"
          aria-label={`${finding.title}: ${finding.file} / ${line}`}
          onClick={() => onLocate(finding.file, finding.startLine)}
        >{finding.file} / {line}</button> : null}
      </div>
      {expanded && (
        <div id={detailId} className="finding-detail" role="region" aria-labelledby={summaryId}>
          <div><span>{t("Evidence")}</span><p>{finding.evidence}</p></div>
          <div><span>{t("Reasoning")}</span><p>{finding.reasoning}</p></div>
          <div><span>{t("Recommendation")}</span><p>{finding.recommendation}</p></div>
          {finding.suggestedPatch && <pre>{finding.suggestedPatch}</pre>}
        </div>
      )}
    </article>
  );
}
