import { describe, expect, it } from "vitest";
import type { ReviewPreparationResponse } from "@consistency/schema";
import { ApiRequestError } from "../api/client";
import {
  formatReviewMutationError,
  isReviewStartDisabled,
  isSafeProductErrorMessage,
  reviewStartDisabledReason
} from "./reviewStart";

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

describe("formatReviewMutationError", () => {
  it("maps known ApiRequestError codes to zh/en product copy", () => {
    const err = new ApiRequestError("provider detail", "LLM_NOT_CONFIGURED", 503);
    expect(formatReviewMutationError(false, err)).toMatch(/not configured/i);
    expect(formatReviewMutationError(true, err)).toMatch(/尚未配置大语言模型/);

    expect(formatReviewMutationError(false, new ApiRequestError("x", "LOCAL_REVIEW_UNAVAILABLE", 503))).toMatch(
      /Local review is unavailable/i
    );
    expect(formatReviewMutationError(true, new ApiRequestError("x", "LOCAL_REPOSITORY_NOT_FOUND", 404))).toMatch(
      /找不到该本地仓库/
    );
    expect(formatReviewMutationError(false, new ApiRequestError("x", "PATH_NOT_ALLOWED", 403))).toMatch(
      /outside the configured/i
    );
    expect(formatReviewMutationError(true, new ApiRequestError("x", "DESKTOP_CONTROL_UNAVAILABLE", 503))).toMatch(
      /桌面控制通道不可用/
    );
    expect(formatReviewMutationError(false, new ApiRequestError("x", "INVALID_LOCAL_REVIEW_REQUEST", 400))).toMatch(
      /Invalid local review request/i
    );
    expect(formatReviewMutationError(true, new ApiRequestError("x", "NOTHING_TO_REVIEW", 409))).toMatch(
      /没有可审查的变更/
    );
  });

  it("prefers safe Chinese server message for known codes when zh", () => {
    const err = new ApiRequestError(
      "尚未配置大语言模型。ConsistenCy 需要配置真实 LLM Provider 后才能执行审查。请前往设置页配置。",
      "LLM_NOT_CONFIGURED",
      503
    );
    expect(formatReviewMutationError(true, err)).toContain("请前往设置页配置");
  });

  it("never echoes secret-looking or stack-like payloads", () => {
    const secretFailure = new Error("SECRET_TOKEN_XYZ /var/run/secrets/provider");
    expect(formatReviewMutationError(true, secretFailure)).toBe("请求失败，请稍后重试。");
    expect(formatReviewMutationError(false, secretFailure)).toBe("Request failed. Please try again later.");

    const apiSecret = new ApiRequestError(
      "Authorization: Bearer sk-abc123 TOKEN=/home/box/.env",
      "WEIRD_CODE",
      500
    );
    expect(formatReviewMutationError(true, apiSecret)).toBe("请求失败，请稍后重试。");
    expect(formatReviewMutationError(false, apiSecret)).toBe("Request failed. Please try again later.");
    expect(isSafeProductErrorMessage(apiSecret.message)).toBe(false);
  });

  it("falls back for unknown errors", () => {
    expect(formatReviewMutationError(true, null)).toBe("请求失败，请稍后重试。");
    expect(formatReviewMutationError(false, new ApiRequestError("boom", "TOTALLY_UNKNOWN", 500))).toBe(
      "Request failed. Please try again later."
    );
  });
});
