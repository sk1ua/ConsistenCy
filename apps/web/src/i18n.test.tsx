import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, type Locale, useI18n, zh } from "./i18n";

function SettingsSavedMessage() {
  const { t } = useI18n();
  return <span>{t("Settings saved.")}</span>;
}

function renderMessage(locale: Locale): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SettingsSavedMessage />
    </I18nProvider>
  );
}

describe("Settings saved translation", () => {
  it("keeps the English Settings confirmation", () => {
    expect(renderMessage("en-US")).toContain("Settings saved.");
  });

  it("localizes the Settings confirmation for Chinese users", () => {
    expect(renderMessage("zh-CN")).toContain("设置已保存。");
  });
});

// Pipeline Inspector surfaces: Runtime Studio, the pipeline inspector, and the
// review wizard. CKPT6 Phase 4 adds the workflow runtime run overlay to the set.
const phaseSources = [
  "pages/WorkflowPage.tsx",
  "routes/RepositoriesPage.tsx",
  "routes/WorkflowXRayView.tsx",
  "routes/ReviewWizardDialog.tsx",
  "components/xray/AgentPipelineXRay.tsx",
  "components/xray/RegistryBrowser.tsx",
  "components/xray/WorkflowRuntimeRunOverlay.tsx",
  "studio/RuntimeStudio.tsx",
  "studio/CopilotPanel.tsx"
] as const;

describe("CKPT6 Phase 2 zh-CN parity", () => {
  it("translates every literal t() key used by the phase surfaces", () => {
    const missing: string[] = [];
    for (const file of phaseSources) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      for (const match of source.matchAll(/(?<![A-Za-z])t\("((?:[^"\\]|\\.)*)"/g)) {
        const key = match[1]!;
        if (!zh[key]) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("translates the dynamic catalog and badge vocabularies", () => {
    for (const key of ["Deterministic", "Planner", "Agent", "Synthesizer", "pure", "read", "revertible", "commit", "direct", "intent"]) {
      expect(zh[key]).toBeTruthy();
    }
  });
});
