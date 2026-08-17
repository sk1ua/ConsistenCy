/**
 * SecretAnalyzer — a narrow, high-signal DETERMINISTIC secret scanner.
 *
 * Deliberately NOT a DLP system and deliberately NOT reckless ("every long
 * string is a secret" produces huge false positives). Supported signals:
 *
 *   - secret.private-key-header   `-----BEGIN … PRIVATE KEY-----` (0.95)
 *   - secret.github-token         ghp_/gho_/ghu_/ghs_/github_pat_ (0.95)
 *   - secret.aws-access-key       AKIA[0-9A-Z]{16} (0.90)
 *   - secret.hardcoded-credential literal quoted assignment of 16+ chars
 *                                 to apiKey/secret/token/password keys,
 *                                 with a placeholder filter (0.70)
 *
 * SAFETY CONTRACT: Evidence payloads NEVER contain the raw secret. They
 * carry a redacted excerpt and a SHA-256 fingerprint of the secret value
 * (for correlation) only. Environment-variable REFERENCES
 * (process.env.X / os.environ[...]) are NOT leaked secrets and are not
 * flagged. Tests use synthetic fake secrets only.
 */

import { createHash } from "node:crypto";
import type { EvidenceInput } from "@consistency/kernel";
import type { Analyzer, AnalyzerDeps, AnalyzerInput } from "../analyzer/types.js";
import { orderEvidence } from "../analyzer/types.js";

export const SECRET_ANALYZER_VERSION = "1.0.0";

const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const GITHUB_TOKEN = /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const HARDCODED_ASSIGNMENT = /(api[_-]?key|secret|token|password|client[_-]?secret)\s*[:=]\s*["']([A-Za-z0-9+/_-]{16,})["']/gi;

/**
 * Placeholder values commonly found in docs/tests/examples. A value matching
 * these is NOT reported (avoids obvious false positives).
 */
const PLACEHOLDER = /^(your|example|sample|dummy|placeholder|changeme|redacted|replace|x{2,})[a-zA-Z0-9._-]*$/i;

const MAX_EXCERPT_LENGTH = 160;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactLine(line: string, secret: string): string {
  return line.split(secret).join("[REDACTED]");
}

function excerpt(line: string): string {
  return line.trim().slice(0, MAX_EXCERPT_LENGTH);
}

export class SecretAnalyzer implements Analyzer {
  readonly id = "secret";
  readonly version = SECRET_ANALYZER_VERSION;

  async analyze(input: AnalyzerInput, deps: AnalyzerDeps): Promise<EvidenceInput[]> {
    const evidence: EvidenceInput[] = [];

    for (const file of [...input.files].sort()) {
      const { path, content } = await deps.readFile(file);
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        const lineNumber = index + 1;

        // 1. Private key header — never store the key body.
        if (PRIVATE_KEY_HEADER.test(line)) {
          evidence.push(
            this.#rule(input, path, lineNumber, "secret.private-key-header", "private-key", 0.95, {
              redactedExcerpt: "-----BEGIN *** PRIVATE KEY-----",
              secretFingerprint: sha256Hex(line.trim()),
            }),
          );
        }

        // 2. GitHub token prefixes.
        for (const match of line.matchAll(GITHUB_TOKEN)) {
          const secret = match[0];
          evidence.push(
            this.#rule(input, path, lineNumber, "secret.github-token", "github-token", 0.95, {
              redactedExcerpt: excerpt(redactLine(line, secret)),
              secretFingerprint: sha256Hex(secret),
            }),
          );
        }

        // 3. AWS access key ids.
        for (const match of line.matchAll(AWS_ACCESS_KEY)) {
          const secret = match[0];
          evidence.push(
            this.#rule(input, path, lineNumber, "secret.aws-access-key", "aws-access-key", 0.9, {
              redactedExcerpt: excerpt(redactLine(line, secret)),
              secretFingerprint: sha256Hex(secret),
            }),
          );
        }

        // 4. Hard-coded literal credential assignments (placeholder-filtered).
        for (const match of line.matchAll(HARDCODED_ASSIGNMENT)) {
          const secret = match[2];
          if (!secret || PLACEHOLDER.test(secret)) continue;
          evidence.push(
            this.#rule(input, path, lineNumber, "secret.hardcoded-credential", "hardcoded-credential", 0.7, {
              redactedExcerpt: excerpt(redactLine(line, secret)),
              secretFingerprint: sha256Hex(secret),
            }),
          );
        }
      });
    }

    return orderEvidence(evidence);
  }

  #rule(
    input: AnalyzerInput,
    path: string,
    startLine: number,
    ruleId: string,
    secretType: string,
    confidence: number,
    redacted: { readonly redactedExcerpt: string; readonly secretFingerprint: string },
  ): EvidenceInput {
    return {
      source: "sast",
      ruleId,
      location: { path, startLine, endLine: startLine },
      confidence,
      payload: {
        kind: "secret",
        secretType,
        ruleId,
        redactedExcerpt: redacted.redactedExcerpt,
        secretFingerprint: redacted.secretFingerprint,
      },
      provenance: {
        repository: input.repository,
        sha: input.headSha,
        analyzer: this.id,
        analyzerVersion: this.version,
      },
    };
  }
}
