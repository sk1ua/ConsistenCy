import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ExternalLink } from "./Link";

describe("ExternalLink", () => {
  it("renders with secure target and rel attributes", () => {
    const html = renderToString(<ExternalLink href="https://example.com">Example</ExternalLink>);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('class="ds-external-link"');
  });
});
