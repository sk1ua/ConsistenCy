import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { mockJobs, mockReports } from "../demo/mockReports";
import { ReportPage } from "./ReportPage";

describe("ReportPage", () => {
  it("exposes evidence, decision, and agent detail tabs", () => {
    const html = renderToString(<I18nProvider initialLocale="en-US">
      <ReportPage job={mockJobs[0]} report={mockReports[0]} onBack={() => undefined} />
    </I18nProvider>);

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain(">Evidence<");
    expect(html).toContain(">Decision<");
    expect(html).toContain(">Agent runs<");
    expect(html).toContain('role="tabpanel"');
  });

  it("announces and withholds a report that belongs to another job", () => {
    const html = renderToString(<I18nProvider initialLocale="en-US">
      <ReportPage job={mockJobs[1]} report={mockReports[0]} onBack={() => undefined} />
    </I18nProvider>);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Report integrity check failed");
    expect(html).not.toContain(mockReports[0]!.summary);
  });
});
