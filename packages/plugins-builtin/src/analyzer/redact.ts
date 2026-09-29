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
 *
 * CANONICAL ARMORED-KEY SOURCE (task-9): every redaction gate in the repository
 * (this module, the workload-review model-visible content policy, the apps/api
 * security redaction) MUST use the patterns/helpers exported here. They used to
 * carry three drifting copies of a narrow algorithm whitelist
 * (`RSA |EC |OPENSSH |DSA `) that missed the modern PKCS#8
 * `-----BEGIN ENCRYPTED PRIVATE KEY-----` and `-----BEGIN PGP PRIVATE KEY
 * BLOCK-----` armor, letting committed key material reach model-visible
 * content and analyzer excerpts.
 *
 * Python twin — keep the two in sync: the deterministic engine's credential
 * scan in `engine/analyzers/security_analyzer.py` (`_CREDENTIAL_PATTERNS`,
 * entry "Private Key Embedded in Source") mirrors `PRIVATE_KEY_HEADER_SOURCE`
 * (same `<ALGO…> PRIVATE KEY [BLOCK]` label grammar, same case-insensitive
 * matching). It detects; this module redacts.
 */

const GITHUB_TOKEN = /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

/**
 * Label between `BEGIN `/`END ` and the closing dashes. Covers the legacy PEM
 * forms (`RSA PRIVATE KEY`, `EC PRIVATE KEY`, `OPENSSH PRIVATE KEY`,
 * `DSA PRIVATE KEY`), PKCS#8 (`ENCRYPTED PRIVATE KEY`), PGP
 * (`PGP PRIVATE KEY BLOCK`) and any future `-----BEGIN <ALGO> PRIVATE
 * KEY-----` spelling — without matching `PUBLIC KEY` or `CERTIFICATE` armor,
 * which is not credential material.
 */
const PRIVATE_KEY_LABEL_SOURCE = "(?:[A-Za-z0-9][A-Za-z0-9-]* )*PRIVATE KEY(?: BLOCK)?";

/** Canonical `-----BEGIN … PRIVATE KEY…-----` header regex source. */
export const PRIVATE_KEY_HEADER_SOURCE = `-----BEGIN ${PRIVATE_KEY_LABEL_SOURCE}-----`;

/**
 * One armored body line: base64-ish payload, optionally behind a unified-diff
 * marker (`+`/`-`/space) or indentation. Used only after an UNTERMINATED
 * header, to blank the body of a block that a size limit or a diff-hunk
 * boundary cut before its END line.
 */
const ARMORED_BODY_LINE_SOURCE = "[ \\t]?[-+]?[A-Za-z0-9+/]{16,}={0,2}";

/**
 * A PGP armor header (`Version: GnuPG v1`), which sits BETWEEN the BEGIN line
 * and the body — a truncated PGP block would otherwise stop scanning there.
 */
const ARMOR_HEADER_LINE_SOURCE = "[A-Za-z][A-Za-z0-9-]*: \\S.*";

/** A blank/whitespace-only line inside an armored block. */
const BLANK_LINE_SOURCE = "[ \\t]*";

/** Any line that may sit inside an armored block before its (missing) END. */
const ARMORED_INNER_LINE_SOURCE = `(?:${ARMORED_BODY_LINE_SOURCE}|${ARMOR_HEADER_LINE_SOURCE}|${BLANK_LINE_SOURCE})`;

/**
 * Fresh NON-global matcher for a single line. Callers that use `.test()` on a
 * line must use this factory (a `/g` regex carries `lastIndex` state and would
 * skip matches between calls).
 */
export function privateKeyHeaderMatcher(): RegExp {
  return new RegExp(PRIVATE_KEY_HEADER_SOURCE, "i");
}

/**
 * Fresh global matcher for one complete armored block. The body is LAZY
 * (`[\s\S]*?`) and the END label must be the SAME label as the BEGIN one
 * (backreference), so a stray `BEGIN ENCRYPTED PRIVATE KEY` line can never
 * swallow unrelated text up to some later, differently-labelled END marker.
 */
export function privateKeyBlockPattern(): RegExp {
  return new RegExp(
    `-----BEGIN (${PRIVATE_KEY_LABEL_SOURCE})-----[\\s\\S]*?-----END \\1-----`,
    "gi",
  );
}

/**
 * Header whose END line is missing — truncated file content, truncated diff,
 * or a diff hunk that starts inside a key block — followed by the lines that
 * belong to it (armor headers, blank lines, armored body lines). Only COMPLETE
 * lines are consumed (each anchored to end of line, so a long identifier with
 * a suffix is left alone) and the repetition stops at the first line that is
 * none of those, so ordinary code/prose after a stray header is NOT swallowed.
 */
function privateKeyTruncatedBlockPattern(): RegExp {
  return new RegExp(
    `${PRIVATE_KEY_HEADER_SOURCE}(?:\\r?\\n${ARMORED_INNER_LINE_SOURCE}(?=\\r?$))*`,
    "gim",
  );
}

/** Readable marker that keeps the block's first line occupied. */
export const REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";

/** Marker for the remaining lines of a redacted block. */
const REDACTED_LINE = "[REDACTED]";

/**
 * Replace a matched armored block with markers while keeping the number of
 * `\n`-separated lines identical, so line numbers after the block do not move
 * (grounding ranges and diff anchors stay valid). The first line keeps a
 * readable marker; every further line — base64 body AND the END line — is
 * blanked. The trailing `\r` of each consumed line is preserved for CRLF input.
 */
function linePreservingKeyReplacement(block: string): string {
  const lines = block.split("\n");
  if (lines.length === 1) return REDACTED_PRIVATE_KEY;
  return lines
    .map((line, index) => {
      const carriageReturn = line.endsWith("\r") ? "\r" : "";
      return (index === 0 ? REDACTED_PRIVATE_KEY : REDACTED_LINE) + carriageReturn;
    })
    .join("\n");
}

/**
 * Line-preserving redaction of armored PRIVATE KEY material (PEM, PKCS#8
 * encrypted, PGP). Redacts complete BEGIN…END blocks first, then any leftover
 * header whose END line is missing together with its armored body lines.
 * Idempotent: the markers contain no armor, so a second pass is a no-op.
 */
export function redactPrivateKeyBlocks(text: string): string {
  return text
    .replace(privateKeyBlockPattern(), linePreservingKeyReplacement)
    .replace(privateKeyTruncatedBlockPattern(), linePreservingKeyReplacement);
}

/** Mask known high-signal credential patterns in excerpt text. */
export function redactSensitiveText(text: string): string {
  return redactPrivateKeyBlocks(text)
    .replace(GITHUB_TOKEN, "[REDACTED]")
    .replace(AWS_ACCESS_KEY, "[REDACTED]");
}
