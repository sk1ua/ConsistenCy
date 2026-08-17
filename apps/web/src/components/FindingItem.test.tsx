import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoReviewReport } from "@consistency/schema";
import { FindingItem } from "./FindingItem";

describe("FindingItem", () => {
  it("renders severity, confidence, file evidence, and title", () => {
    const finding = demoReviewReport.findings[0];
    expect(finding).toBeDefined();
    const html = renderToString(<FindingItem finding={finding!} />);
    expect(html).toContain(finding!.title);
    expect(html).toContain(finding!.severity);
    expect(html).toContain(finding!.confidence);
    expect(html).toContain(finding!.file);
  });

  it("keeps the diff locator outside the expandable summary control", () => {
    const finding = demoReviewReport.findings[0]!;
    const html = renderToString(<FindingItem finding={finding} onLocate={() => undefined} />);
    const summaryEnd = html.indexOf("</button>");
    const locatorStart = html.indexOf('class="finding-locate"');

    expect(summaryEnd).toBeGreaterThan(0);
    expect(locatorStart).toBeGreaterThan(summaryEnd);
    expect(html.slice(0, summaryEnd)).not.toContain("finding-locate");
  });
});
