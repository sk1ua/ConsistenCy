/**
 * Checkpoint build / parse / integrity verification (PR-3).
 *
 * Checkpoints are in-memory, provider-neutral, JSON-serializable
 * representations of one ContextImage. They include full page records
 * (content + hashes + provenance) so a restore into a FRESH ContextManager is
 * self-contained. Restore FAILS CLOSED: any stored contentHash that does not
 * match the hash of its text is rejected — corruption is never silently
 * accepted. No SQLite, no files, no persistence backend in this PR.
 */

import {
  CONTEXT_PAGE_KINDS,
  isResidency,
  type ContextCheckpoint,
  type ContextPage,
  type ContextPageId,
} from "./types.js";
import { hashText, type PageStore } from "./page-store.js";
import { resolveImage } from "./working-set.js";
import { CheckpointCorruptionError, CheckpointFormatError } from "./errors.js";
import type { ImageRecord } from "./image.js";

export const CHECKPOINT_FORMAT = "consistency.context.v1" as const;

const PAGE_ID_RE = /^[^\s]+$/;
const IMAGE_ID_RE = /^[^\s]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Build a serializable checkpoint of the image's current effective state. */
export function buildCheckpoint(image: ImageRecord, store: PageStore): ContextCheckpoint {
  const resolved = resolveImage(image, store);
  return {
    format: CHECKPOINT_FORMAT,
    image: {
      id: image.id,
      generation: image.generation,
      base: image.base ? { imageId: image.base.imageId, generation: image.base.generation } : undefined,
      pages: resolved.map((entry) => ({ pageId: entry.page.id, residency: entry.residency })),
    },
    pages: resolved.map((entry) => entry.page),
  };
}

export function serializeCheckpoint(checkpoint: ContextCheckpoint): string {
  return JSON.stringify(checkpoint);
}

/**
 * Parse a serialized checkpoint and validate its shape. Malformed input
 * throws {@link CheckpointFormatError} — never a partial checkpoint.
 */
export function parseCheckpoint(raw: string): ContextCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CheckpointFormatError("not valid JSON");
  }
  return validateCheckpointShape(parsed);
}

/** Validate a parsed/constructed checkpoint object's shape and consistency. */
export function validateCheckpointShape(value: unknown): ContextCheckpoint {
  if (typeof value !== "object" || value === null) {
    throw new CheckpointFormatError("checkpoint must be an object");
  }
  const cp = value as Record<string, unknown>;

  if (cp.format !== CHECKPOINT_FORMAT) {
    throw new CheckpointFormatError(`unsupported format ${String(cp.format)}`);
  }

  const image = cp.image as Record<string, unknown> | undefined;
  if (!image || typeof image !== "object") {
    throw new CheckpointFormatError("image block missing");
  }
  if (typeof image.id !== "string" || !IMAGE_ID_RE.test(image.id)) {
    throw new CheckpointFormatError("image.id must be a non-empty string");
  }
  if (!Number.isInteger(image.generation) || (image.generation as number) < 1) {
    throw new CheckpointFormatError("image.generation must be a positive integer");
  }
  if (image.base !== undefined) {
    const base = image.base as Record<string, unknown>;
    if (
      typeof base.imageId !== "string" ||
      !IMAGE_ID_RE.test(base.imageId) ||
      !Number.isInteger(base.generation) ||
      (base.generation as number) < 1
    ) {
      throw new CheckpointFormatError("image.base is malformed");
    }
  }

  const pages = cp.pages;
  if (!Array.isArray(pages) || pages.some((p) => typeof p !== "object" || p === null)) {
    throw new CheckpointFormatError("pages must be an array of page records");
  }
  const pageById = new Map<string, ContextPage>();
  for (const rawPage of pages as Record<string, unknown>[]) {
    const page = validatePageShape(rawPage);
    if (pageById.has(page.id)) {
      throw new CheckpointFormatError(`duplicate page id ${page.id}`);
    }
    pageById.set(page.id, page);
  }

  const refs = image.pages;
  if (!Array.isArray(refs)) {
    throw new CheckpointFormatError("image.pages must be an array");
  }
  const seenRefs = new Set<string>();
  for (const ref of refs as Record<string, unknown>[]) {
    if (typeof ref.pageId !== "string" || !pageById.has(ref.pageId)) {
      throw new CheckpointFormatError(`image reference to unknown page ${String(ref.pageId)}`);
    }
    if (!isResidency(ref.residency)) {
      throw new CheckpointFormatError(`invalid residency ${String(ref.residency)}`);
    }
    if (seenRefs.has(ref.pageId)) {
      throw new CheckpointFormatError(`duplicate image reference ${ref.pageId}`);
    }
    seenRefs.add(ref.pageId);
  }

  return value as unknown as ContextCheckpoint;
}

function validatePageShape(raw: Record<string, unknown>): ContextPage {
  if (typeof raw.id !== "string" || !PAGE_ID_RE.test(raw.id)) {
    throw new CheckpointFormatError("page.id must be a non-empty string");
  }
  if (!(CONTEXT_PAGE_KINDS as readonly string[]).includes(String(raw.kind))) {
    throw new CheckpointFormatError(`invalid page kind ${String(raw.kind)}`);
  }
  if (typeof raw.text !== "string") {
    throw new CheckpointFormatError(`page ${raw.id} text must be a string`);
  }
  if (typeof raw.contentHash !== "string" || !SHA256_RE.test(raw.contentHash)) {
    throw new CheckpointFormatError(`page ${raw.id} contentHash must be a 64-char hex sha256`);
  }
  if (!Number.isInteger(raw.estimatedTokens) || (raw.estimatedTokens as number) < 0) {
    throw new CheckpointFormatError(`page ${raw.id} estimatedTokens must be a non-negative integer`);
  }
  const provenance = raw.provenance as Record<string, unknown> | undefined;
  if (
    !provenance ||
    typeof provenance !== "object" ||
    typeof provenance.producer !== "string" ||
    provenance.producer.length === 0 ||
    typeof provenance.producerVersion !== "string" ||
    provenance.producerVersion.length === 0
  ) {
    throw new CheckpointFormatError(`page ${raw.id} provenance is malformed`);
  }
  return {
    id: raw.id as ContextPageId,
    kind: raw.kind as ContextPage["kind"],
    source: raw.source as ContextPage["source"] | undefined,
    contentHash: raw.contentHash as string,
    text: raw.text as string,
    estimatedTokens: raw.estimatedTokens as number,
    provenance: {
      repository: typeof provenance.repository === "string" ? provenance.repository : undefined,
      sha: typeof provenance.sha === "string" ? provenance.sha : undefined,
      producer: provenance.producer as string,
      producerVersion: provenance.producerVersion as string,
    },
  };
}

/**
 * Verify checkpoint integrity: every page's contentHash must equal the
 * SHA-256 of its text. Throws {@link CheckpointCorruptionError} otherwise.
 */
export function verifyCheckpointIntegrity(checkpoint: ContextCheckpoint): void {
  for (const page of checkpoint.pages) {
    if (page.contentHash !== hashText(page.text)) {
      throw new CheckpointCorruptionError(
        `page ${page.id} contentHash does not match its text`,
        page.id,
      );
    }
  }
}
