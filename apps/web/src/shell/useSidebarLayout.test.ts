import { describe, expect, it } from "vitest";
import {
  parseSidebarLayout,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_LAYOUT_STORAGE_KEY,
  SIDEBAR_WIDTH_BOUNDS
} from "./useSidebarLayout";

describe("sidebar layout persistence", () => {
  it("uses a v3-prefixed versioned storage key and restores valid state", () => {
    expect(SIDEBAR_LAYOUT_STORAGE_KEY).toBe("consistency.v3.sidebar-layout");
    expect(parseSidebarLayout(JSON.stringify({ version: 1, collapsed: true, width: 320 }))).toEqual({
      collapsed: true,
      width: 320
    });
  });

  it("rejects stale versions, malformed JSON and non-boolean collapse flags", () => {
    const fallback = { collapsed: false, width: 230 };
    expect(parseSidebarLayout(JSON.stringify({ version: 0, collapsed: true }), fallback)).toEqual(fallback);
    expect(parseSidebarLayout("not-json", fallback)).toEqual(fallback);
    expect(parseSidebarLayout(null, fallback)).toEqual(fallback);
    expect(parseSidebarLayout(JSON.stringify({ version: 1, collapsed: "yes", width: 300 }))).toEqual({
      collapsed: false,
      width: 300
    });
  });

  it("clamps the persisted width to the shell bounds", () => {
    expect(parseSidebarLayout(JSON.stringify({ version: 1, width: 10 })).width).toBe(SIDEBAR_WIDTH_BOUNDS.min);
    expect(parseSidebarLayout(JSON.stringify({ version: 1, width: 900 })).width).toBe(SIDEBAR_WIDTH_BOUNDS.max);
    expect(parseSidebarLayout(JSON.stringify({ version: 1, width: 262.7 })).width).toBe(263);
  });

  it("keeps the collapsed rail width outside the draggable bounds", () => {
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(56);
    expect(SIDEBAR_WIDTH_BOUNDS.min).toBeGreaterThan(SIDEBAR_COLLAPSED_WIDTH);
  });
});
