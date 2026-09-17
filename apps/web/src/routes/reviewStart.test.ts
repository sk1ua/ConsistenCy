import { describe, expect, it } from "vitest";
import { isReviewStartDisabled, reviewStartDisabledReason } from "./reviewStart";
import type { ReviewPreparationResponse } from "@consistency/schema";

function prep(partial: Partial<ReviewPreparationResponse> = {}): ReviewPreparationResponse {
  return {
    repository: {
      id: "r1",
      displayName: "demo",
      sourceKind: "local_git",
      trust: "trusted_local"
    },
    sources: {
      workingTree: { available: false, changedFileCount: 0 },
      branch: { available: false }
    },
    model: {
      default: { provider: "none", model: "" },
      providers: [],
      pendingRestart: null
    },
    canStartReview: false,
    blockingReasons: [],
    ...partial
  };
}

describe("reviewStart helpers", () => {
  it("disables when canStartReview is not true", () => {
    expect(isReviewStartDisabled(undefined)).toBe(true);
    expect(isReviewStartDisabled(prep({ canStartReview: true, blockingReasons: [] }))).toBe(false);
    expect(isReviewStartDisabled(prep({ canStartReview: false }))).toBe(true);
  });

  it("prefers blockingReasons and falls back clearly", () => {
    expect(reviewStartDisabledReason(undefined, true)).toMatch(/正在读取|Reading review readiness/);
    expect(reviewStartDisabledReason(prep({ blockingReasons: ["LLM 未配置"] }), true)).toBe("LLM 未配置");
    expect(
      reviewStartDisabledReason(
        prep({
          blockingReasons: [],
          model: {
            default: { provider: "none", model: "" },
            providers: [],
            pendingRestart: null
          }
        }),
        false
      )
    ).toMatch(/not configured/i);
  });
});
