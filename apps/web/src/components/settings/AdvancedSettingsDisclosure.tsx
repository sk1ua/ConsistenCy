import { useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../i18n";
import { Button } from "../../design-system/Button";

export function AdvancedSettingsDisclosure({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <section className={`settings-advanced${open ? " is-open" : ""}`} aria-label={t("Advanced settings")}>
      <div className="settings-advanced-summary">
        <span className="settings-advanced-icon"><SlidersHorizontal size={16} /></span>
        <div>
          <strong>{t("Advanced settings")}</strong>
          <p>{t("Runtime, GitHub App automation and low-frequency service controls.")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="settings-advanced-trigger"
          icon={<ChevronDown size={14} />}
          aria-expanded={open}
          aria-controls="settings-advanced-content"
          onClick={() => setOpen(current => !current)}
        >
          {t(open ? "Hide advanced" : "Show advanced")}
        </Button>
      </div>
      {open && <div id="settings-advanced-content" className="settings-advanced-content">{children}</div>}
    </section>
  );
}
