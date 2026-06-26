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
});
