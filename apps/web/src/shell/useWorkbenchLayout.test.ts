import { describe, expect, it } from "vitest";
import { parseWorkbenchLayout, WORKBENCH_LAYOUT_STORAGE_KEY } from "./useWorkbenchLayout";

describe("workbench layout persistence", () => {
  it("uses a versioned storage key and restores valid layout state", () => {
    expect(WORKBENCH_LAYOUT_STORAGE_KEY).toBe("consistency.workbench-layout.v1");
    expect(parseWorkbenchLayout(JSON.stringify({
      version: 1,
      explorerCollapsed: true,
      explorerWidth: 312,
      inspectorOpen: true,
      inspectorWidth: 410,
      ledgerOpen: true
    }))).toEqual({
      explorerCollapsed: true,
      explorerWidth: 312,
      inspectorOpen: true,
      inspectorWidth: 410,
      ledgerOpen: true
    });
  });

  it("rejects stale versions and clamps persisted panel widths", () => {
    expect(parseWorkbenchLayout(JSON.stringify({ version: 0, explorerCollapsed: true })).explorerCollapsed).toBe(false);
    const clamped = parseWorkbenchLayout(JSON.stringify({ version: 1, explorerWidth: 10, inspectorWidth: 900 }));
    expect(clamped.explorerWidth).toBe(210);
    expect(clamped.inspectorWidth).toBe(520);
  });
});
