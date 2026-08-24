import { useI18n } from "../../i18n";
import { SettingHelp } from "../SettingHelp";
import type { SecretName } from "../../hooks/useSettingsForm";

export function SecretField({ name, label, configured, value, clear, help, helpHref, multiline = false, onValue, onClear }: {
  name: SecretName;
  label: string;
  configured: boolean;
  value: string;
  clear: boolean;
  help: string;
  helpHref?: string;
  multiline?: boolean;
  onValue: (name: SecretName, value: string) => void;
  onClear: (name: SecretName, value: boolean) => void;
}) {
  const { t } = useI18n();
  const id = `setting-${name}`;
  const helpId = `${id}-help`;
  const isPendingSave = Boolean(value.trim());
  const statusLabel = isPendingSave
    ? t("Pending save")
    : configured && !clear
    ? t("Saved")
    : t("Not configured");
  const statusClass = isPendingSave ? "pending" : configured && !clear ? "configured" : "missing";

  return <div className="setting-field secret-field">
    <label htmlFor={id}>{t(label)}<span className={statusClass}>{statusLabel}</span></label>
    {multiline
      ? <textarea id={id} aria-describedby={helpId} rows={3} value={value} disabled={clear} onChange={event => onValue(name, event.target.value)} placeholder={t(configured ? "Leave blank to keep the stored value" : "Paste a PEM key or enter a readable file path")} />
      : <input id={id} aria-describedby={helpId} type="password" autoComplete="new-password" value={value} disabled={clear} onChange={event => onValue(name, event.target.value)} placeholder={t(configured ? "Leave blank to keep the stored value" : "Enter a new secret")} />}
    <SettingHelp id={helpId} text={help} href={helpHref} />
    {configured && <label className="clear-secret"><input type="checkbox" checked={clear} onChange={event => onClear(name, event.target.checked)} />{t("Remove the stored value")}</label>}
  </div>;
}
