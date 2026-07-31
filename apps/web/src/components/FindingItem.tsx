import type { ReviewFinding } from "@consistency/schema";
import { ChevronDown, FileCode2 } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "./StatusBadge";
import { useI18n } from "../i18n";

export function FindingItem({ finding }: { finding: ReviewFinding }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const line = finding.startLine === undefined
    ? t("File-level")
    : finding.startLine === finding.endLine ? `L${finding.startLine}` : `L${finding.startLine}-${finding.endLine}`;
  return (
    <article className="finding-item">
      <button className="finding-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <FileCode2 size={17} />
        <span className="finding-title"><strong>{finding.title}</strong><small>{finding.file} / {line}</small></span>
        <span className="finding-badges">
          <StatusBadge value={finding.severity} />
          <StatusBadge value={finding.confidence} />
        </span>
        <ChevronDown className={expanded ? "rotated" : ""} size={17} />
      </button>
      {expanded && (
        <div className="finding-detail">
          <div><span>{t("Evidence")}</span><p>{finding.evidence}</p></div>
          <div><span>{t("Reasoning")}</span><p>{finding.reasoning}</p></div>
          <div><span>{t("Recommendation")}</span><p>{finding.recommendation}</p></div>
          {finding.suggestedPatch && <pre>{finding.suggestedPatch}</pre>}
        </div>
      )}
    </article>
  );
}
