import { describe, expect, it } from "vitest";
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
