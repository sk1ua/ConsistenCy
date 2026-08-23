import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, type Locale, useI18n } from "./i18n";

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
