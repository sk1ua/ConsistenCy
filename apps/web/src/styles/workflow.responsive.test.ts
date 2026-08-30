import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowCss = readFileSync(resolve(__dirname, "workflow.css"), "utf8");
const shellCss = readFileSync(resolve(__dirname, "responsive.css"), "utf8");
const tabsCss = readFileSync(resolve(__dirname, "workbench-shell.css"), "utf8");
const tokensCss = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

function splitVarArguments(body: string): [string, string | undefined] {
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) return [body.slice(0, index), body.slice(index + 1)];
  }
  return [body, undefined];
}

function cssVarCalls(css: string): Array<{ token: string; fallback?: string }> {
  const calls: Array<{ token: string; fallback?: string }> = [];
  for (let start = css.indexOf("var("); start >= 0; start = css.indexOf("var(", start + 4)) {
    let depth = 1;
    let end = start + 4;
    while (end < css.length && depth > 0) {
      if (css[end] === "(") depth += 1;
      else if (css[end] === ")") depth -= 1;
      end += 1;
    }
    if (depth !== 0) continue;
    const [token, fallback] = splitVarArguments(css.slice(start + 4, end - 1));
    calls.push({ token: token.trim(), fallback: fallback?.trim() });
  }
  return calls;
}

function removeVarFunctions(css: string): string {
  let output = "";
  for (let index = 0; index < css.length;) {
    if (!css.startsWith("var(", index)) { output += css[index]; index += 1; continue; }
    let depth = 1;
    index += 4;
    while (index < css.length && depth > 0) {
      if (css[index] === "(") depth += 1;
      else if (css[index] === ")") depth -= 1;
      index += 1;
    }
  }
  return output;
}

function cssVarFallbackIsSafe(fallback: string | undefined, definitions: Set<string>): boolean {
  if (!fallback) return false;
  const nested = cssVarCalls(fallback);
  const literal = removeVarFunctions(fallback).replace(/[\s,]/g, "");
  return (literal.length > 0 || nested.length > 0) && nested.every(call => definitions.has(call.token) || cssVarFallbackIsSafe(call.fallback, definitions));
}

function extractMediaBlock(css: string, header: string): string {
  const start = css.indexOf(header);
  if (start < 0) return "";
  let depth = 0;
  for (let index = css.indexOf("{", start); index >= 0 && index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

describe("Runtime Studio responsive CSS contract", () => {
  it("renders the desktop gate-evidence rail as three columns inside one shared breakpoint", () => {
    expect(workflowCss).toContain(".studio-grid { display:grid; grid-template-columns:minmax(0, 1fr); align-items:stretch; gap:10px; min-width:0; }");
    expect(workflowCss).toContain("@media (min-width: 1280px)");
    expect(workflowCss).toContain(".studio-grid { grid-template-columns:minmax(196px, 216px) minmax(0, 1fr) minmax(280px, 344px); gap:var(--space-md); }");
    expect(workflowCss).toContain(".studio-rail { display:flex; flex-direction:column; gap:10px; padding:10px; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface); }");
    expect(workflowCss).toContain(".studio-rail-gates { flex-direction:column; flex-wrap:nowrap; align-items:stretch; gap:6px; }");
    expect(workflowCss).toContain(".studio-rail-gate-body { flex-direction:column; flex-wrap:nowrap; align-items:flex-start; gap:4px; }");
    expect(workflowCss).not.toContain("@media (max-width: 1279px)");
    expect(workflowCss).not.toContain("@media (min-width: 1180.01px)");
    expect(workflowCss).not.toContain("max-width: 900px");
    expect(workflowCss).not.toContain("min-width: 901px");
    expect(workflowCss).not.toContain("min-width: 900.01px");
    expect(workflowCss).not.toContain("display:revert");
  });

  it("keeps no legacy top action row, full-width gate spine, or full-width run warning", () => {
    expect(workflowCss).not.toContain(".studio-actions");
    expect(workflowCss).not.toContain(".studio-gate-spine");
    expect(workflowCss).not.toContain(".studio-gate-heading");
    expect(workflowCss).not.toContain(".studio-run-reason {");
    expect(workflowCss).not.toContain(".validation-rail");
    expect(workflowCss).not.toContain(".studio-library");
    expect(workflowCss).not.toContain(".execution-rail");
    expect(workflowCss).not.toContain(".studio-graph-section");
    expect(workflowCss).not.toMatch(/\.studio-[a-z-]+[^{\n]*\{[^}]*var\(--warning-soft\)/);
  });

  it("keeps the frame/viewport/cue graph contract with keyboard-reachable scrolling", () => {
    expect(workflowCss).toContain(".studio-graph-frame { position:relative; overflow:hidden; min-width:0; max-width:100%; }");
    expect(workflowCss).toContain(".studio-graph-viewport { position:relative; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; scrollbar-width:thin; background:var(--surface-subtle); }");
    expect(workflowCss).toContain(".studio-graph-viewport::-webkit-scrollbar { height:6px; }");
    expect(workflowCss).toContain(".studio-graph-viewport:focus-visible { outline:2px solid var(--primary); outline-offset:-2px; }");
    expect(workflowCss).toContain(".studio-graph-cue { position:absolute; top:0; bottom:0; width:14px; z-index:2; pointer-events:none; opacity:0; }");
    expect(workflowCss).toContain(".studio-graph-frame.cue-left .studio-graph-cue-left { opacity:1; }");
    expect(workflowCss).toContain(".studio-graph-frame.cue-right .studio-graph-cue-right { opacity:1; }");
    expect(workflowCss).toContain(".studio-graph { position:relative; min-width:320px; background:var(--surface-subtle); }");
    expect(workflowCss).not.toContain(".studio-graph-viewport::after");
    expect(workflowCss).not.toContain(".studio-graph { position:relative; overflow:auto;");
  });

  it("keeps desktop graph hooks and collapses only presentation to a single mobile stack", () => {
    expect(workflowCss).toContain(".studio-grid { display:grid; grid-template-columns:minmax(0, 1fr); align-items:stretch; gap:10px; min-width:0; }");
    expect(workflowCss).toContain(".studio-canvas { min-width:0; overflow-x:hidden; padding:10px; }");
    expect(workflowCss).toContain(".studio-rail-title { display:none; }");
    expect(workflowCss).toContain(".studio-inspector:not([open]) > :not(summary) { display:none; }");
    expect(workflowCss).toContain(".studio-graph-frame { width:100%; }");
    expect(workflowCss).toContain(".studio-graph-viewport { width:100%; scrollbar-width:none; }");
    expect(workflowCss).toContain(".studio-graph-viewport::-webkit-scrollbar { display:none; }");
    expect(shellCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(workflowCss).not.toContain("body { overflow-x: hidden");
  });

  it("compacts the mobile gate rail into wrapping pills with one enabled next action and 44px touch targets", () => {
    expect(workflowCss).toContain(".studio-rail-gates { display:flex; flex-direction:row; flex-wrap:wrap; align-items:stretch; gap:6px; margin:0; padding:0; list-style:none; }");
    expect(workflowCss).toContain(".studio-rail-gate { display:flex; flex:0 1 auto;");
    expect(workflowCss).toContain(".studio-rail-gate-body small { color:var(--muted); font-size:11px; line-height:1.35; overflow-wrap:anywhere; display:none; }");
    expect(workflowCss).toContain(".studio-rail-gate .studio-gate-action { display:none; }");
    expect(workflowCss).toContain(".studio-rail-gate .studio-gate-action.is-current-action { display:inline-flex; }");
    expect(workflowCss).not.toContain(".studio-gate-action:not(:disabled)");
    expect(workflowCss).toContain(".studio-gate-action { justify-content:center; min-height:40px; }");
    expect(workflowCss).toContain(".studio-defselect select { min-height:40px; }");
    expect(workflowCss).toContain(".studio-canvas-toolbar input { width:100%; min-width:0; min-height:44px; }");
    expect(workflowCss).toContain(".studio-palette button, .studio-connect button, .studio-connect select { min-height:44px; }");
    expect(workflowCss).not.toMatch(/grid-template-columns:repeat\((?:3|4|5),\s*minmax\(0,\s*1fr\)\)[^}]*studio/);
  });

  it("requires every Studio CSS variable reference to be defined or guarded by a safe fallback", () => {
    const studioCss = workflowCss.slice(workflowCss.indexOf("/* Runtime Studio"));
    const definitions = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(match => match[1]).filter((token): token is string => token !== undefined));
    for (const call of cssVarCalls(studioCss)) expect(definitions.has(call.token) || cssVarFallbackIsSafe(call.fallback, definitions), `${call.token} must be defined or have a safe fallback`).toBe(true);
  });

  it("rejects nested fallbacks that only reference missing variables", () => {
    expect(cssVarFallbackIsSafe("var(--also-missing)", new Set())).toBe(false);
    expect(cssVarFallbackIsSafe("var(--defined)", new Set(["--defined"]))).toBe(true);
    expect(cssVarFallbackIsSafe("var(--missing, var(--also-missing))", new Set())).toBe(false);
  });

  it("keeps per-gate evidence and rail actions on the desktop rail with status glyph colors", () => {
    expect(workflowCss).toContain(".studio-rail-gate.gate-passed { border-left-color:var(--success); }");
    expect(workflowCss).toContain(".studio-rail-gate.gate-current { border-left-color:var(--primary); }");
    expect(workflowCss).toContain(".studio-rail-gate.gate-blocked { border-left-color:var(--danger); }");
    expect(workflowCss).toContain(".studio-gate-action { justify-content:center; min-height:40px; }");
    expect(workflowCss).toContain(".studio-gate-action { min-height:32px; }");
    expect(workflowCss).toContain(".studio-next { display:flex; flex-wrap:wrap; flex-direction:column; align-items:flex-start; justify-content:space-between; gap:4px 8px; font-size:12px; color:var(--muted); }");
  });

  it("never presents a disabled Run or primary gate action as an enabled primary at any width", () => {
    expect(workflowCss).toContain(".studio-gate-action:disabled, .studio-run-button:disabled { background:var(--surface-muted,var(--surface-subtle)); border-color:var(--border-strong); color:var(--muted-strong,var(--muted)); opacity:1; }");
    expect(workflowCss).not.toContain(".studio-actions .studio-run-button");
  });

  it("keeps graph nodes readable at their deterministic geometry", () => {
    expect(workflowCss).toContain(".studio-node { display:flex; flex-direction:column; gap:5px;");
    expect(workflowCss).toContain(".studio-node strong,.studio-node span,.studio-node small { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }");
  });

  it("keeps the definition summary and node quick list compact inside the inspector column", () => {
    expect(workflowCss).toContain(".studio-summary-facts { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:6px; margin:0; }");
    expect(workflowCss).toContain(".studio-node-list button { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; min-height:36px;");
    expect(workflowCss).toContain(".studio-visually-hidden { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }");
  });

  it("keeps mobile composition local and preserves the shell contracts", () => {
    expect(shellCss).toContain("@media (max-width: 680px)");
    expect(shellCss).toContain(".repo-first-sidebar {\n    width: 56px !important;");
    expect(tabsCss).toContain(".workflow-sub-nav {");
    expect(tabsCss).toContain("overflow-x: auto;");
    expect(workflowCss).not.toContain(".studio-rail-gates { grid-template-columns");
    expect(workflowCss).not.toMatch(/\.studio-rail-gates \{[^}]*overflow-x:\s*auto/);
  });

  it("keeps the Studio section free of max-width media queries", () => {
    const studioStart = workflowCss.indexOf("runtime-studio");
    expect(studioStart).toBeGreaterThanOrEqual(0);
    expect(workflowCss.slice(studioStart)).not.toContain("@media (max-width");
  });

  it("keeps desktop-exclusive grid columns and vertical gate rail inside the single 1280px block", () => {
    const desktopBlock = extractMediaBlock(workflowCss, "@media (min-width: 1280px)");
    expect(desktopBlock).toContain("@media (min-width: 1280px)");
    expect(desktopBlock).toContain("grid-template-columns");
    expect(desktopBlock).toContain(".studio-rail-gates { flex-direction:column; flex-wrap:nowrap; align-items:stretch; gap:6px; }");
    const outsideDesktopBlock = workflowCss.replace(desktopBlock, "");
    expect(outsideDesktopBlock).toContain(".studio-grid { display:grid; grid-template-columns:minmax(0, 1fr); align-items:stretch; gap:10px; min-width:0; }");
    expect(outsideDesktopBlock).not.toContain("grid-template-columns:minmax(196px, 216px) minmax(0, 1fr) minmax(280px, 344px)");
    expect(outsideDesktopBlock).toContain(".studio-rail-gates { display:flex; flex-direction:row; flex-wrap:wrap; align-items:stretch; gap:6px; margin:0; padding:0; list-style:none; }");
    expect(outsideDesktopBlock).not.toMatch(/\.studio-rail-gates \{[^}]*flex-direction:column/);
  });

  it("restores studio compact values from 600px without flipping the gate rail direction", () => {
    const restoreBlock = extractMediaBlock(workflowCss, "@media (min-width: 600px)");
    expect(restoreBlock).toContain("@media (min-width: 600px)");
    expect(restoreBlock).toContain(".runtime-studio { gap:var(--space-md); }");
    expect(restoreBlock).toContain(".studio-rail { padding:12px; }");
    expect(restoreBlock).toContain(".studio-next { flex-direction:row; align-items:baseline; justify-content:space-between; }");
    expect(restoreBlock).not.toMatch(/\.studio-rail-gates \{[^}]*flex-direction:column/);
  });
});
