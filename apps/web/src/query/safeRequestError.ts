export function safeRequestError(error: unknown, fallback = "Request failed"): string {
  const raw = error instanceof Error ? error.message : fallback;
  if (/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|etc)\/|authorization|bearer\s+|token\s*[=:])/i.test(raw)) {
    return `${fallback}. Check the local API logs for details.`;
  }
  return raw.slice(0, 180);
}
