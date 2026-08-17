import { describe, expect, it } from "vitest";
import { runModeFromPath } from "./ReportRoute";

describe("run route modes", () => {
  it("selects each canonical run workbench mode from the pathname", () => {
    expect(runModeFromPath("/runs/run-1/overview")).toBe("overview");
    expect(runModeFromPath("/runs/run-1/diff")).toBe("diff");
    expect(runModeFromPath("/runs/run-1/evidence")).toBe("evidence");
    expect(runModeFromPath("/runs/run-1/notebook")).toBe("notebook");
  });

  it("falls back to overview for compatibility routes", () => {
    expect(runModeFromPath("/reports/run-1")).toBe("overview");
    expect(runModeFromPath("/runs/run-1/unknown")).toBe("overview");
  });
});
