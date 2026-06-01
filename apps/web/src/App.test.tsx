import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { App } from "./App";

describe("App", () => {
  it("is a renderable React component", () => {
    expect(App).toBeTypeOf("function");
  });

  it("renders the typed PR report dashboard sections", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Multi-agent PR coordination");
    expect(html).toContain("Job Orchestration");
    expect(html).toContain("Demo fixture fallback");
    expect(html).toContain("Highest-Risk Files");
    expect(html).toContain("Evidence Chain");
    expect(html).toContain("Human Review Queue");
    expect(html).toContain("docs/EVALUATION.md");
  });
});
