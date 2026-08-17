import { describe, expect, it } from "vitest";
import { nextTabId } from "./tabNavigation";

const tabs = ["evidence", "decision", "agents"] as const;

describe("nextTabId", () => {
  it("wraps arrow-key tab navigation", () => {
    expect(nextTabId(tabs, "evidence", "ArrowLeft")).toBe("agents");
    expect(nextTabId(tabs, "agents", "ArrowRight")).toBe("evidence");
    expect(nextTabId(tabs, "evidence", "ArrowDown")).toBe("decision");
  });

  it("supports Home and End and ignores unrelated keys", () => {
    expect(nextTabId(tabs, "decision", "Home")).toBe("evidence");
    expect(nextTabId(tabs, "decision", "End")).toBe("agents");
    expect(nextTabId(tabs, "decision", "Enter")).toBeUndefined();
  });
});
