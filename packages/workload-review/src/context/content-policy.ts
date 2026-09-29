/**
 * Model-visible content policy — the single gate that decides what repository
 * text may leave the trusted host and enter an LLM request.
 *
 * Separation of concerns (audit P0-01):
 *   - DETERMINISTIC ANALYSIS (TS evidence runner, Python stage) runs in trusted
 *     local processes and consumes the RAW snapshot content — redacting its
 *     input would blind secret detection and corrupt evidence integrity.
 *   - MODEL-VISIBLE TEXT (file contents, diffs, patches, metadata rendered
 *     into prompts) must pass THIS policy no matter which read path produced
 *     it: context-builder pre-filter, SHA-pinned RepositorySnapshot, or any
 *     future source. Redaction is line-count preserving so grounding line
 *     numbers stay valid against the sanitized view.
 *
 * The path gate is the canonical `isSecretPath` shared with the apps/api
 * context loader, so a path the loader excludes can never re-enter through
 * the snapshot read path.
 */

import { isSecretPath, type PRReviewContext } from "@consistency/schema";
import {
  redactPrivateKeyBlocks,
  redactSensitiveText as redactAnalyzerExcerpts,
} from "@consistency/plugins-builtin";

// Single-line patterns. Each replacement keeps the line count unchanged.
// Mirrors the apps/api context-loader redaction (url credentials, bearer
// headers, API keys, key=value secrets) so both gates stay equivalent.
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const AUTHORIZATION_HEADER = /\bAuthorization\s*:\s*Bearer(?:\s+[A-Za-z0-9._~+/-]+)?/gi;
const BARE_BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+/g;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret|credential)\b\s*[:=]\s*["']?[^\s,"']+["']?/gi;

const URL_WITH_CREDENTIALS = /https?:\/\/[^\s<>"']+/gi;

function redactUrlCredentials(value: string): string {
  return value.replace(URL_WITH_CREDENTIALS, (candidate) => {
    let suffix = "";
    while (/[.,;!?)]$/.test(candidate)) suffix = candidate.slice(-1) + suffix, candidate = candidate.slice(0, -1);
    try {
      const parsed = new URL(candidate);
      if (!parsed.username && !parsed.password) return candidate + suffix;
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}${suffix}`;
    } catch {
      return candidate + suffix;
    }
  });
}

// Multi-line: a PEM/PKCS#8/PGP block spans lines, so the CANONICAL shared
// helper replaces it LINE BY LINE (first line keeps a marker, the remaining
// lines are blanked) to keep the absolute line numbers of everything after it
// unchanged — grounding depends on that. The pattern lives in
// @consistency/plugins-builtin so this gate, the analyzer excerpts, and
// apps/api can never drift apart (task-9: the local whitelist here missed
// ENCRYPTED/PGP armor).

/**
 * Redact credential material from text that will be sent to a model.
 * Line-count preserving and idempotent.
 */
export function redactModelVisibleText(value: string): string {
  let redacted = redactPrivateKeyBlocks(value);
  redacted = redactUrlCredentials(redacted);
  redacted = redacted.replace(GITHUB_TOKEN, "[REDACTED]");
  redacted = redacted.replace(OPENAI_STYLE_KEY, "[REDACTED]");
  redacted = redacted.replace(AWS_ACCESS_KEY, "[REDACTED]");
  redacted = redacted.replace(AUTHORIZATION_HEADER, "Authorization: Bearer [REDACTED]");
  redacted = redacted.replace(BARE_BEARER, "Bearer [REDACTED]");
  redacted = redacted.replace(SECRET_ASSIGNMENT, "$1=[REDACTED]");
  // Analyzer excerpt sanitizer (private keys, GitHub/AWS tokens) as a final
  // pass — defense in depth for anything the patterns above miss.
  return redactAnalyzerExcerpts(redacted);
}

function sanitizeTextMap(values: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [path, content] of Object.entries(values)) {
    if (isSecretPath(path)) continue; // excluded paths never re-enter here
    output[path] = redactModelVisibleText(content);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Diff section gate. `context.diff` is a pre-concatenated string, so a secret
// file's section cannot be filtered by the changedFiles path loop above.
// Pattern redaction alone is insufficient there: a `.env` line like
// `INTERNAL_SERVICE_TICKET=qq-771234` matches no credential pattern yet is
// exactly the material the path gate exists to withhold. The projection below
// parses the unified diff into per-file sections and DROPS every section whose
// path (or rename source) is a secret path, then reassembles the rest
// verbatim. Two header styles occur in production: GitHub `raw_diff`
// (`diff --git a/x b/y ...`) and the local working-tree builder (`--- a/x`
// followed by `+++ b/y`, no `diff --git` line).
// ---------------------------------------------------------------------------

const GIT_SECTION_HEADER = /^diff --git a\/(.+?) b\/(.+?)\r?$/;
const FROM_LINE = /^--- (?:a\/|b\/)?(.+?)\r?(?:\t.*)?$/;
const TO_LINE = /^\+\+\+ (?:a\/|b\/)?(.+?)\r?(?:\t.*)?$/;
const NULL_PATH = "/dev/null";

type DiffSection = {
  lines: string[];
  /** New-side path; undefined only when the section has no usable header. */
  path?: string;
  /** Rename source path when it differs from the resolved `path`. */
  previousPath?: string;
  /** True once this section consumed its `---`/`+++` file pair. */
  sawFilePair: boolean;
};

/** Strip git quoting (`"a/path with spaces"`). */
function unquotePath(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Resolve a section's identity from its `---`/`+++` (or `diff --git`) sides:
 * `/dev/null` on the new side marks a deletion (the old side IS the path) and
 * vice versa for an addition. `previousPath` records only a rename source that
 * genuinely differs from the resolved path.
 */
function resolveSectionPaths(from: string, to: string): { path: string | undefined; previousPath: string | undefined } {
  const path = to === NULL_PATH ? (from === NULL_PATH ? undefined : from) : to;
  const previousPath = from !== NULL_PATH && from !== path ? from : undefined;
  return { path, previousPath };
}

/**
 * Structurally remove secret-path file sections from a unified diff. Sections
 * whose header path cannot be determined are kept — the pattern redaction
 * applied afterwards remains the backstop for unparseable text. Ambiguous
 * header-shaped content lines (e.g. a removed line `-- a/.env` directly
 * followed by an added `++ b/x`) resolve toward DROPPING, i.e. the failure
 * mode is over-redaction, never a leak.
 */
export function dropSecretPathDiffSections(diff: string): string {
  if (!diff) return diff;
  const lines = diff.split("\n");

  const preamble: string[] = [];
  const sections: DiffSection[] = [];
  let current: DiffSection | undefined;

  const sectionIsSecret = (section: DiffSection): boolean =>
    (section.path !== undefined && isSecretPath(section.path))
    || (section.previousPath !== undefined && isSecretPath(section.previousPath));

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    const gitMatch = GIT_SECTION_HEADER.exec(line);
    if (gitMatch !== null) {
      const { path, previousPath } = resolveSectionPaths(unquotePath(gitMatch[1]!), unquotePath(gitMatch[2]!));
      current = {
        lines: [line],
        path,
        previousPath,
        sawFilePair: false,
      };
      sections.push(current);
      continue;
    }

    const fromMatch = FROM_LINE.exec(line);
    const nextLine = lines[index + 1];
    if (fromMatch !== null && nextLine !== undefined) {
      const toMatch = TO_LINE.exec(nextLine);
      if (toMatch !== null) {
        const from = unquotePath(fromMatch[1]!);
        const to = unquotePath(toMatch[1]!);
        if (current !== undefined && !current.sawFilePair) {
          // `---`/`+++` pair inside a `diff --git` section refines its paths.
          current.lines.push(line, nextLine);
          current.sawFilePair = true;
          const resolved = resolveSectionPaths(from, to);
          current.path = resolved.path ?? current.path;
          current.previousPath = resolved.previousPath;
        } else {
          // Local builder format: the pair itself starts the section.
          current = {
            lines: [line, nextLine],
            ...resolveSectionPaths(from, to),
            sawFilePair: true,
          };
          sections.push(current);
        }
        index += 1; // the consumed `+++` line
        continue;
      }
    }

    if (current !== undefined) current.lines.push(line);
    else preamble.push(line);
  }

  const kept = sections.filter(section => !sectionIsSecret(section));
  return [...preamble, ...kept.flatMap(section => section.lines)].join("\n");
}

/**
 * Project a review context onto its model-visible form: secret-path contents
 * are dropped entirely (the changed-file list still names the path so the
 * model can flag committed secret files), every remaining text surface —
 * file contents, baselines, diffs, patches, project metadata — is redacted,
 * and secret-path diff sections are removed structurally rather than trusted
 * to pattern redaction. Returns a NEW context; the input keeps its raw
 * contents for local analysis.
 */
export function applyModelContentPolicy(context: PRReviewContext): PRReviewContext {
  return {
    ...context,
    fileContents: sanitizeTextMap(context.fileContents),
    baseFileContents: sanitizeTextMap(context.baseFileContents),
    projectMetadata: sanitizeTextMap(context.projectMetadata),
    diff: redactModelVisibleText(dropSecretPathDiffSections(context.diff)),
    changedFiles: context.changedFiles.map((file) => {
      if (file.patch === undefined) return file;
      if (isSecretPath(file.path)) {
        const { patch: _patch, ...rest } = file;
        return rest;
      }
      return { ...file, patch: redactModelVisibleText(file.patch) };
    }),
  };
}
