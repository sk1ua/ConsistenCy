import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@consistency/schema";
import { FindingItem } from "./FindingItem";

const testFinding: ReviewFinding = {
  id: "finding-test-1",
  agent: "Security",
  title: "API authorization requires verification",
  severity: "medium",
  confidence: "hypothesis",
  file: "apps/api/src/http.ts",
  evidence: "The current API routes do not expose an authorization guard in the reviewed excerpt.",
  reasoning: "Management endpoints may be reachable without an API token.",
  recommendation: "Add a bearer-token guard before exposing management routes.",
  uncertainty: "The deployment proxy configuration was not available to the reviewer.",
  tags: ["api", "authorization"]
};

describe("FindingItem", () => {
  it("renders severity, confidence, file evidence, and title", () => {
    const html = renderToString(<FindingItem finding={testFinding} />);
    expect(html).toContain(testFinding.title);
    expect(html).toContain(testFinding.severity);
    expect(html).toContain(testFinding.confidence);
    expect(html).toContain(testFinding.file);
  });

  it("keeps the diff locator outside the expandable summary control", () => {
    const html = renderToString(<FindingItem finding={testFinding} onLocate={() => undefined} />);
    const summaryEnd = html.indexOf("</button>");
    const locatorStart = html.indexOf('class="finding-locate"');

    expect(summaryEnd).toBeGreaterThan(0);
    expect(locatorStart).toBeGreaterThan(summaryEnd);
    expect(html.slice(0, summaryEnd)).not.toContain("finding-locate");
  });
});
