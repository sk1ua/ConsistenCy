import type { ReviewPreparationResponse } from "@consistency/schema";
import { ApiRequestError } from "../api/client";

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

const REVIEW_MUTATION_ERROR_COPY: Record<string, { zh: string; en: string }> = {
  LLM_NOT_CONFIGURED: {
    zh: "尚未配置大语言模型。请前往设置配置 DeepSeek、OpenAI 或 Anthropic。",
    en: "Language model is not configured. Configure DeepSeek, OpenAI, or Anthropic in Settings."
  },
  LLM_PROVIDER_NOT_CONFIGURED: {
    zh: "所选模型提供商尚未配置。请先在设置中配置对应 API 密钥。",
    en: "The selected LLM provider is not configured. Configure its API key in Settings first."
  },
  INVALID_REVIEW_MODEL: {
    zh: "审查模型无效。请检查提供商与模型名称后重试。",
    en: "The review model is invalid. Check the provider and model name, then try again."
  },
  LOCAL_REVIEW_UNAVAILABLE: {
    zh: "本地审查当前不可用。请确认本地审查根目录已配置且服务可用。",
    en: "Local review is unavailable. Confirm local review roots are configured and the service is up."
  },
  LOCAL_REPOSITORY_NOT_FOUND: {
    zh: "找不到该本地仓库，或仓库尚未注册。",
    en: "The local repository could not be found or is not registered."
  },
  PATH_NOT_ALLOWED: {
    zh: "仓库路径不在允许的本地审查根目录内。",
    en: "Repository path is outside the configured local review roots."
  },
  DESKTOP_CONTROL_UNAVAILABLE: {
    zh: "桌面控制通道不可用。请从桌面应用发起此操作。",
    en: "Desktop control is unavailable. Start this action from the desktop app."
  },
  DESKTOP_CONTROL_UNAUTHORIZED: {
    zh: "桌面控制未授权。请重新打开桌面应用后重试。",
    en: "Desktop control is unauthorized. Reopen the desktop app and try again."
  },
  INVALID_LOCAL_REVIEW_REQUEST: {
    zh: "本地审查请求无效。请确认已选择有效仓库。",
    en: "Invalid local review request. Confirm a valid repository is selected."
  },
  NOTHING_TO_REVIEW: {
    zh: "当前没有可审查的变更。",
    en: "There is nothing to review right now."
  },
  NOT_A_REPOSITORY: {
    zh: "目标路径不是有效的 Git 仓库。",
    en: "The target path is not a valid Git repository."
  },
  REPOSITORY_NOT_FOUND: {
    zh: "仓库不存在或已取消注册。",
    en: "The repository was not found or is no longer registered."
  }
};

/** True when a server message looks like product copy safe to show as-is. */
export function isSafeProductErrorMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 400) return false;
  // Stack / exception dumps
  if (/\b(at\s+\S+\s+\(|Error:\s|Traceback \(most recent call last\)|Exception in)/i.test(trimmed)) {
    return false;
  }
  if (trimmed.includes("\n") && /stack|trace|exception/i.test(trimmed)) return false;
  // Secrets / credentials / tokens
  if (/\b(api[_-]?key|secret|token|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]+|ghp_[a-z0-9]+|authorization)\b/i.test(trimmed)) {
    return false;
  }
  // Absolute home / credential-looking paths and env dumps
  if (/(\/Users\/|\/home\/|[A-Z]:\\Users\\)/i.test(trimmed) && /(secret|\.env|credential|token|api.?key)/i.test(trimmed)) {
    return false;
  }
  if (/^[A-Z_]+=(.*)$/m.test(trimmed) && /KEY|TOKEN|SECRET|PASSWORD/i.test(trimmed)) {
    return false;
  }
  return true;
}

function looksPrimarilyChinese(message: string): boolean {
  const chinese = (message.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const letters = (message.match(/[A-Za-z]/g) ?? []).length;
  return chinese >= 2 && chinese >= letters * 0.3;
}

/**
 * Honest, user-safe copy for review start / mutation failures.
 * Prefer known codes; then safe Chinese/product server messages; never echo secrets.
 */
export function formatReviewMutationError(zh: boolean, error: unknown): string {
  const fallback = zh ? "请求失败，请稍后重试。" : "Request failed. Please try again later.";
  if (!(error instanceof ApiRequestError)) {
    return fallback;
  }

  const mapped = REVIEW_MUTATION_ERROR_COPY[error.code];
  if (mapped) {
    // Prefer server product copy when it is already Chinese and safe.
    if (zh && error.message && isSafeProductErrorMessage(error.message) && looksPrimarilyChinese(error.message)) {
      return error.message.trim();
    }
    return zh ? mapped.zh : mapped.en;
  }

  // Unknown codes: only surface safe Chinese product copy from the API.
  // English/raw fragments fall back — never guess or echo opaque dumps.
  if (zh && error.message && isSafeProductErrorMessage(error.message) && looksPrimarilyChinese(error.message)) {
    return error.message.trim();
  }

  return fallback;
}
