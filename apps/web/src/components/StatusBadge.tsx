import type { Confidence, JobStatus, RiskLevel, Severity } from "@consistency/schema";
import { useI18n } from "../i18n";

export function StatusBadge({ value }: { value: JobStatus | RiskLevel | Severity | Confidence | string }) {
  const { t } = useI18n();
  return <span className={`badge badge-${value}`}>{t(value.replaceAll("_", " "))}</span>;
}
