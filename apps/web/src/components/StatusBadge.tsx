import type { Confidence, JobStatus, RiskLevel, Severity } from "@consistency/schema";

export function StatusBadge({ value }: { value: JobStatus | RiskLevel | Severity | Confidence | string }) {
  return <span className={`badge badge-${value}`}>{value.replaceAll("_", " ")}</span>;
}
