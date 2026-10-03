import { describe, expect, it, vi } from "vitest";
import { parseLeanSecondSample } from "./leanSecondSample";

describe("parseLeanSecondSample", () => {
  it("keeps only the three lean specialists in first-seen order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseLeanSecondSample(undefined)).toEqual([]);
    expect(parseLeanSecondSample("")).toEqual([]);
    expect(parseLeanSecondSample("Maintainability, Correctness, Style, Maintainability")).toEqual(["Maintainability", "Correctness"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
