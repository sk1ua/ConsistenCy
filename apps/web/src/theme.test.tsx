import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { resolveTheme, ThemeProvider } from "./theme";

describe("resolveTheme", () => {
  it("resolves the system preference from the OS signal", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("resolves explicit preferences regardless of the OS signal", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("ThemeProvider", () => {
  it("renders children without a DOM environment", () => {
    const html = renderToString(
      <ThemeProvider><div>theme-child</div></ThemeProvider>
    );
    expect(html).toContain("theme-child");
  });
});

describe("anti-flash script", () => {
  it("uses the same localStorage key as ThemeProvider", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
    const bootstrap = readFileSync(join(here, "..", "public", "theme-bootstrap.js"), "utf8");
    expect(indexHtml).toContain('src="/theme-bootstrap.js"');
    expect(bootstrap).toContain('"consistency.theme.v1"');
    expect(indexHtml).not.toContain("<script>");
  });
});
