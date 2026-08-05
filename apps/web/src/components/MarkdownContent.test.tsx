import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders headings, lists, GFM tables, links, and code", () => {
    const html = renderToString(<MarkdownContent content={`## Risk brief

- inspect \`engine/runner.py\`

| Signal | Score |
| --- | ---: |
| security | 0.8 |

\`\`\`python
print("review")
\`\`\`

[Evidence](https://example.com/evidence)`} />);

    expect(html).toContain("<h2>Risk brief</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain("language-python");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("drops raw HTML from untrusted model and repository content", () => {
    const html = renderToString(<MarkdownContent content={'Safe\n\n<script>alert("x")</script>\n\n<img src="x" onerror="alert(1)">'} />);

    expect(html).toContain("Safe");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });
});
