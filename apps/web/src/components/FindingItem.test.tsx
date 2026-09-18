// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root && host) {
      act(() => { root!.unmount(); });
      host.remove();
    }
    root = undefined;
    host = undefined;
  });

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

  it("exposes accept/dismiss controls and reports disposition changes", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onDispositionChange = vi.fn();
    act(() => {
      root!.render(
        <FindingItem
          finding={testFinding}
          disposition={null}
          onDispositionChange={onDispositionChange}
        />
      );
    });
    const buttons = [...host.querySelectorAll("button")].map(btn => btn.textContent);
    expect(buttons).toContain("Accept");
    expect(buttons).toContain("Dismiss");
    const dismiss = [...host.querySelectorAll("button")].find(btn => btn.textContent === "Dismiss");
    act(() => { dismiss?.click(); });
    expect(onDispositionChange).toHaveBeenCalledWith("dismissed");
  });

  it("mutes dismissed findings visually", () => {
    const html = renderToString(
      <FindingItem finding={testFinding} disposition="dismissed" onDispositionChange={() => undefined} />
    );
    expect(html).toContain("finding-item--dismissed");
    expect(html).toContain("Dismissed");
  });
});
