import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tokensPath = join(here, "tokens.css");
const tokens = readFileSync(tokensPath, "utf8");

const REQUIRED_TOKENS = [
  "background", "surface", "surface-subtle", "surface-muted",
  "foreground", "muted", "muted-strong",
  "border", "border-strong", "border-subtle",
  "sidebar", "sidebar-muted", "sidebar-hover",
  "primary", "primary-strong", "primary-soft", "primary-faint", "primary-line",
  "success", "success-strong", "success-soft", "success-faint",
  "warning", "warning-strong", "warning-soft", "warning-faint",
  "danger", "danger-strong", "danger-soft", "danger-faint",
  "focus-ring", "shadow-soft", "shadow-card", "scrim"
];

// Colors intentionally left hardcoded: heartbeat sparkline box-shadow gradient
// stops (animated alpha, not rendered as text). All text colors must use tokens.
const ALLOWED_HEX = new Set<string>();
const ALLOWED_RGBA = new Set(["rgba(22,133,107,0)", "rgba(22,133,107,0.45)"]);

function cssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...cssFiles(full));
    } else if (name.endsWith(".css") && name !== "tokens.css") {
      files.push(full);
    }
  }
  return files;
}

describe("design tokens", () => {
  it("defines every required token in both themes", () => {
    expect(tokens).toContain(':root {');
    expect(tokens).toContain(':root[data-theme="dark"] {');
    const darkStart = tokens.indexOf(':root[data-theme="dark"] {');
    expect(darkStart).toBeGreaterThan(0);
    const light = tokens.slice(0, darkStart);
    const dark = tokens.slice(darkStart);
    for (const name of REQUIRED_TOKENS) {
      const pattern = new RegExp("--" + name + "\\s*:");
      expect(light).toMatch(pattern);
      expect(dark).toMatch(pattern);
    }
  });

  it("uses the dark theme as the documented default", () => {
    expect(tokens).toContain('--background: #0b0d10');
    expect(tokens).toContain('--surface: #12161c');
    expect(tokens).toContain('--surface-muted: #1a2028');
    expect(tokens).toContain('--foreground: #e7eaee');
    expect(tokens).toContain('--primary: #6fa8ff');
  });

  it("leaves no unmapped hardcoded colors in component styles", () => {
    const leftovers: string[] = [];
    for (const file of cssFiles(here)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (!ALLOWED_HEX.has(match[0].toLowerCase())) {
          leftovers.push(file + " -> " + match[0]);
        }
      }
      for (const match of text.matchAll(/rgba?\([^)]*\)/g)) {
        const normalized = match[0].toLowerCase().replace(/\s+/g, "");
        if (!ALLOWED_RGBA.has(normalized)) {
          leftovers.push(file + " -> " + match[0]);
        }
      }
    }
    expect(leftovers).toEqual([]);
  });
});
