/**
 * Excerpt redaction — defense in depth for ANY analyzer that embeds source
 * line text into Evidence payloads.
 *
 * Evidence must never persist raw credential values, even indirectly: if a
 * secret sits on a line that also violates a style rule, the style excerpt
 * must not carry the credential. This utility masks high-signal secret
 * patterns (GitHub tokens, AWS access keys, private-key blocks) in excerpt
 * text. It is NOT a secret detector — detection logic lives in the secret
 * analyzer; this is only output sanitization.
 */

const GITHUB_TOKEN = /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const PRIVATE_KEY_BODY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g;

/** Mask known high-signal credential patterns in excerpt text. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(PRIVATE_KEY_BODY, "-----BEGIN *** PRIVATE KEY----- [REDACTED]")
    .replace(PRIVATE_KEY_HEADER, "-----BEGIN *** PRIVATE KEY-----")
    .replace(GITHUB_TOKEN, "[REDACTED]")
    .replace(AWS_ACCESS_KEY, "[REDACTED]");
}
