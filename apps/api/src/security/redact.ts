const SECRET_VALUE_PATTERN = /\b(api[_-]?key|token|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret)\b\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi;

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
];

const ABSOLUTE_PATH_PATTERNS = [
  /\b[A-Za-z]:[\\/](?:[^\s<>:"|?*]+[\\/])*[^\s<>:"|?*]*/g,
  /(?:^|\s)\/(?:home|Users|var|tmp|opt|srv|workspace)\/[^\s]+/g
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of CREDENTIAL_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  redacted = redacted.replace(SECRET_VALUE_PATTERN, "$1=[REDACTED]");
  return redacted;
}

export function sanitizePublicError(value: string): string {
  let sanitized = redactSensitiveText(value);
  for (const pattern of ABSOLUTE_PATH_PATTERNS) sanitized = sanitized.replace(pattern, " [PATH_REDACTED]");
  return sanitized.trim() || "Request failed";
}

export function sanitizePublishFailure(error: unknown, token?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (token) {
    message = message.split(token).join("[REDACTED]");
  }
  return sanitizePublicError(message).slice(0, 500);
}
