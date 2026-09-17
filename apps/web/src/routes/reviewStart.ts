import type { ReviewPreparationResponse } from "@consistency/schema";

export function isReviewStartDisabled(preparation?: ReviewPreparationResponse): boolean {
  return preparation?.canStartReview !== true;
}

/** Prefer API blockingReasons; fall back to a clear local explanation. */
export function reviewStartDisabledReason(
  preparation: ReviewPreparationResponse | undefined,
  zh: boolean
): string {
  const reason = preparation?.blockingReasons?.[0]?.trim();
  if (reason) return reason;
  if (!preparation) {
    return zh ? "正在读取审查准备状态…" : "Reading review readiness…";
  }
  if (preparation.model?.default?.provider === "none") {
    return zh ? "尚未配置大语言模型" : "Language model is not configured";
  }
  return zh ? "审查尚未就绪" : "Review is not ready";
}

export function formatReviewMutationError(zh: boolean, _error: unknown): string {
  return zh ? "请求失败，请稍后重试。" : "Request failed. Please try again later.";
}
