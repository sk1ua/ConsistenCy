const SECRET_VALUE_PATTERN = /\b(api[_-]?key|token|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret|credential)\b\s*[:=]\s*["']?[^\s,"']+["']?/gi;

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
  /\bAuthorization\s*:\s*Bearer(?:\s+[A-Za-z0-9._~+/-]+)?/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+/gi,
];

// Absolute paths are parsed with explicit boundaries rather than a greedy regex.
// This keeps punctuation/sentence suffixes while retaining comma/semicolon path
// segments such as `,bar/baz.ts` and `;bar\\baz.ts`.
const PATH_SUFFIX_WORDS = /^(?:because|due\s+to|while|when|and|token|password|secret|api[_-]?key|authorization|bearer|permission)\b/i;
const PATH_SEGMENT = /[^\s,;\/\\]+[\/\\]/;


const MAX_PUBLIC_STRING_LENGTH = 2_000;
const SENSITIVE_KEY_TOKENS = new Set([
  "token", "password", "secret", "authorization", "bearer", "jwt", "credential",
  "apikey", "accesstoken", "refreshtoken", "authtoken", "privatekey", "cookie",
]);
const MAX_SANITIZE_DEPTH = 12;
const MAX_SANITIZE_KEYS = 512;
const MAX_SANITIZE_ITEMS = 512;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function normalizedKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map(part => part.toLowerCase())
    .filter(Boolean)
    .map((part, index, all) => index > 0 && all[index - 1] === "api" ? "apikey" : part);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return SENSITIVE_KEY_TOKENS.has(normalized) || normalizedKeyTokens(key).some(token => SENSITIVE_KEY_TOKENS.has(token));
}

function redactUrlCredentials(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
    let suffix = "";
    while (/[.,;!?)]$/.test(candidate)) suffix = candidate.slice(-1) + suffix, candidate = candidate.slice(0, -1);
    try {
      const parsed = new URL(candidate);
      if (!parsed.username && !parsed.password) return candidate + suffix;
      // Rebuild from WHATWG components so raw/encoded @, IPv6, ports, and the
      // complete userinfo are removed without leaving a credential fragment.
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}${suffix}`;
    } catch {
      return candidate + suffix;
    }
  });
}

export function redactSensitiveText(value: string): string {
  let redacted = redactUrlCredentials(value);
  for (const pattern of CREDENTIAL_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  redacted = redacted.replace(SECRET_VALUE_PATTERN, "$1=[REDACTED]");
  return redacted;
}

function isPathStart(value: string, index: number): boolean {
  const before = value[index - 1] ?? "";
  if (/[A-Za-z0-9_]/.test(before)) return false;
  // Do not reinterpret the path portion of an ordinary URL as a local path.
  if (index >= 3 && /(?:https?|file):$/.test(value.slice(Math.max(0, index - 8), index))) return false;
  if (before === "/" && index >= 2 && /(?:https?|file):$/.test(value.slice(Math.max(0, index - 9), index - 1))) return false;
  return true;
}

function pathCandidateAt(value: string, index: number): { end: number; quoted: boolean } | undefined {
  const rest = value.slice(index);
  const fileUrl = /^file:\/\//i.test(rest);
  let pathStart = index;
  let quoted = false;
  if (fileUrl) {
    pathStart += 7;
    while (value[pathStart] === "/") pathStart++;
  } else if (value[index] === '"' || value[index] === "'") {
    quoted = true;
    pathStart++;
  }
  const path = value.slice(pathStart);
  const unc = path.length > 2 && path[0] === "\\" && path[1] === "\\" && /[\\/]/.test(path.slice(2));
  const absolute = /^[A-Za-z]:[\\/]/.test(path)
    || unc
    // Unix diagnostics may contain a root with only one segment (`/etc`).
    || new RegExp(String.raw`^/(?!/)(?=[^\s/]+(?:/|[.,;!?)]?(?:\s|$)|$))`).test(path);
  if (!absolute) return undefined;

  let end = pathStart;
  let sawSeparator = false;
  while (end < value.length) {
    const char = value[end]!;
    if (!quoted && /^\\n(?:stack|authorization)\b/i.test(value.slice(end))) break;
    if (char === "\r" || char === "\n") break;
    if (quoted && char === value[index]) { end++; break; }
    if (!quoted && (char === "," || char === ";")) {
      // Comma/semicolon belongs to the path only when another path segment
      // follows; otherwise it is sentence punctuation.
      const after = value.slice(end + 1);
      if (!PATH_SEGMENT.test(after)) break;
    }
    if (!quoted && /\s/.test(char)) {
      const after = value.slice(end).replace(/^\s+/, "");
      if (PATH_SUFFIX_WORDS.test(after)) break;
      // A path may contain spaces, but only when another path segment follows;
      // otherwise this is the start of an ordinary sentence suffix.
      if (!PATH_SEGMENT.test(after)) break;
    }
    if (char === "/" || char === "\\") sawSeparator = true;
    end++;
  }
  while (end > pathStart && /[.,!?)]/.test(value[end - 1]!)) end--;
  return { end, quoted };
}

function containsAbsolutePath(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (isPathStart(value, index) && pathCandidateAt(value, index)) return true;
  }
  return false;
}

function redactAbsolutePaths(value: string): string {
  const source = value.replace(/file:\/\/[^\s<>"']+/gi, "file://[PATH_REDACTED]");
  let output = "";
  let index = 0;
  while (index < source.length) {
    const candidate = isPathStart(source, index) ? pathCandidateAt(source, index) : undefined;
    if (!candidate) { output += source[index]; index++; continue; }
    const prefix = source.slice(index, candidate.end);
    if (/^file:\/\//i.test(prefix)) output += "file://[PATH_REDACTED]";
    else if (candidate.quoted) output += source[index] + "[PATH_REDACTED]" + source[candidate.end - 1];
    else output += " [PATH_REDACTED]";
    index = candidate.end;
  }
  return output;
}

export function sanitizePublicError(value: string): string {
  const redacted = redactAbsolutePaths(redactSensitiveText(value));
  return redacted.trim() || "Request failed";
}

export function sanitizeExecutionError(value: string): string {
  const sanitized = sanitizePublicError(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return sanitized.slice(0, MAX_PUBLIC_STRING_LENGTH) || "Execution failed";
}

export function sanitizeValidationIssues<T extends { code: string; path: readonly (string | number)[]; message: string }>(issues: readonly T[]) {
  return issues.map(issue => ({ code: issue.code, path: [...issue.path], message: sanitizeExecutionError(issue.message) }));
}

function safeString(value: string): string {
  return sanitizeExecutionError(value).slice(0, MAX_PUBLIC_STRING_LENGTH);
}

/**
 * Recursively sanitizes data without flattening it. `seen` is an active-path
 * set, not a global visited set: shared references are sanitized independently,
 * while only an actual back-edge is reported as circular.
 */
export function sanitizePublicValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return safeString(value);
  if (typeof value === "function") return "[FUNCTION]";
  if (typeof value === "symbol") return "[SYMBOL]";
  if (typeof value === "bigint") return "[BIGINT]";
  if (depth >= MAX_SANITIZE_DEPTH) return "[TRUNCATED]";

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  if (value instanceof Error) {
    const output = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(output, "name", { value: safeString(value.name), enumerable: true });
    Object.defineProperty(output, "message", { value: safeString(value.message), enumerable: true });
    return output;
  }
  if (typeof value !== "object") return "[UNSUPPORTED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output = (value.slice(0, MAX_SANITIZE_ITEMS).map(item => sanitizePublicValue(item, depth + 1, seen))) as unknown[];
      if (value.length > MAX_SANITIZE_ITEMS) output.push("[TRUNCATED]");
      return output;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, MAX_SANITIZE_KEYS)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const sanitized = isSensitiveKey(key) ? "[REDACTED]" : sanitizePublicValue(child, depth + 1, seen);
      Object.defineProperty(output, key, { value: sanitized, enumerable: true, writable: true, configurable: true });
    }
    if (Object.keys(value as object).length > MAX_SANITIZE_KEYS) {
      Object.defineProperty(output, "_truncated", { value: "[TRUNCATED]", enumerable: true });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeStructuredData<T>(value: T): T {
  return sanitizePublicValue(value) as T;
}

/** Fail-closed write-time detector for executable definitions and legacy `with` data. */
export function containsSensitiveData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return redactSensitiveText(value) !== value || containsAbsolutePath(value);
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some(item => containsSensitiveData(item, seen));
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) || containsSensitiveData(child, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

export function sanitizePublishFailure(error: unknown, token?: string): string {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "Publish failed";
  if (token) message = message.split(token).join("[REDACTED]");
  return sanitizePublicError(message).slice(0, 500);
}
