import type { ReviewPreparationResponse } from "@consistency/schema";

export function isReviewStartDisabled(preparation?: ReviewPreparationResponse): boolean {
  return preparation?.canStartReview !== true;
}

export function formatReviewMutationError(zh: boolean, _error: unknown): string {
  return zh ? "请求失败，请稍后重试。" : "Request failed. Please try again later.";
}
