import type { ReviewFinding } from "@consistency/schema";
import { ChevronDown, FileCode2 } from "lucide-react";
import { useId, useState } from "react";
import type { FindingClientDisposition } from "../utils/findingDisposition";
import { StatusBadge } from "./StatusBadge";
import { useI18n } from "../i18n";

export function FindingItem({
  finding,
  onLocate,
  disposition,
  onDispositionChange
}: {
  finding: ReviewFinding;
  onLocate?: (file: string, line: number | undefined) => void;
  disposition?: FindingClientDisposition | null;
  onDispositionChange?: (disposition: FindingClientDisposition | null) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const summaryId = `${detailId}-summary`;
  const line = finding.startLine === undefined
    ? t("File-level")
    : finding.startLine === finding.endLine ? `L${finding.startLine}` : `L${finding.startLine}-${finding.endLine}`;
  const muted = disposition === "dismissed" || disposition === "accepted";
  const className = [
    "finding-item",
    disposition === "dismissed" ? "finding-item--dismissed" : "",
    disposition === "accepted" ? "finding-item--accepted" : ""
  ].filter(Boolean).join(" ");

  return (
    <article className={className} data-disposition={disposition ?? "none"}>
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
          <span className="finding-title">
            <strong>{finding.title}</strong>
            {onLocate ? null : <small>{finding.file} / {line}</small>}
          </span>
          <span className="finding-badges">
            <StatusBadge value={finding.severity} />
            <StatusBadge value={finding.confidence} />
            {disposition === "dismissed" ? <span className="finding-disposition-pill">{t("Dismissed")}</span> : null}
            {disposition === "accepted" ? <span className="finding-disposition-pill finding-disposition-pill--accepted">{t("Accepted")}</span> : null}
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
      {onDispositionChange ? (
        <div className="finding-disposition-actions" role="group" aria-label={t("Finding disposition")}>
          {disposition !== "accepted" ? (
            <button
              type="button"
              className="finding-disposition-btn"
              onClick={() => onDispositionChange("accepted")}
            >{t("Accept")}</button>
          ) : (
            <button
              type="button"
              className="finding-disposition-btn"
              onClick={() => onDispositionChange(null)}
            >{t("Undo accept")}</button>
          )}
          {disposition !== "dismissed" ? (
            <button
              type="button"
              className="finding-disposition-btn"
              onClick={() => onDispositionChange("dismissed")}
            >{t("Dismiss")}</button>
          ) : (
            <button
              type="button"
              className="finding-disposition-btn"
              onClick={() => onDispositionChange(null)}
            >{t("Undo dismiss")}</button>
          )}
        </div>
      ) : null}
      {expanded && (
        <div id={detailId} className="finding-detail" role="region" aria-labelledby={summaryId} data-muted={muted ? "true" : undefined}>
          <div><span>{t("Evidence")}</span><p>{finding.evidence}</p></div>
          <div><span>{t("Reasoning")}</span><p>{finding.reasoning}</p></div>
          <div><span>{t("Recommendation")}</span><p>{finding.recommendation}</p></div>
          {finding.suggestedPatch && <pre>{finding.suggestedPatch}</pre>}
        </div>
      )}
    </article>
  );
}
