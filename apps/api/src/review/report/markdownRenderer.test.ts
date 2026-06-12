import { describe, expect, it } from "vitest";
import { demoReviewReport } from "@consistency/schema";
import { renderReviewComment } from "./markdownRenderer";

describe("renderReviewComment", () => {
  it("renders a bounded GitHub review comment with a full report link", () => {
    const markdown = renderReviewComment(demoReviewReport, {
      providerName: "mock",
      webBaseUrl: "http://127.0.0.1:5173",
      maxFindings: 1
    });

    expect(markdown).toContain("# ConsistenCy PR Review");
    expect(markdown).toContain("Demo mode");
    expect(markdown).toContain("apps/api/src/http.ts");
    expect(markdown).toContain("View full report in ConsistenCy");
    expect(markdown.length).toBeLessThanOrEqual(60_000);
  });
});
