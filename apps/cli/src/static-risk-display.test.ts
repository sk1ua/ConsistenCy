import { expect, it } from "vitest";
import { staticRiskDisplayLabel } from "@consistency/schema";
import { riskLevelLabel } from "./report";

it("renders the shared peak-file static label instead of the composed machine level", () => {
  const label = "Severe Drift / No Baseline / skipped";
  expect(riskLevelLabel("low", label)).toBe(staticRiskDisplayLabel("low", label));
  expect(riskLevelLabel("low", label)).toBe("Severe Drift / No Baseline / Skipped");
  expect(riskLevelLabel("high", "Stable")).toBe("Stable");
});
