/**
 * PageStore — the Kernel's immutable ContextPage storage.
 *
 * Pages are created once and frozen; semantic changes never mutate a page —
 * a new page revision is created and the image reference replaced. The store
 * is content-UNaware for identity purposes: every createPage produces a new
 * page object (no deduplication), so correctness never depends on
 * deduplication. (Content-addressed dedup is a possible future optimization.)
 */

import { createHash, randomUUID } from "node:crypto";
import {
  asContextPageId,
  type ContextPage,
  type ContextPageId,
  type CreatePageSpec,
} from "./types.js";
import { PageAlreadyExistsError } from "./errors.js";

/** SHA-256 hex digest of UTF-8 text — the canonical content hash. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function makeContextPageId(): ContextPageId {
  return asContextPageId(`page_${randomUUID()}`);
}

export class PageStore {
  readonly #pages = new Map<ContextPageId, ContextPage>();

  /**
   * Create a new immutable page revision. The contentHash is computed from
   * the text deterministically; the stored record is frozen.
   *
   * @throws {PageAlreadyExistsError} on duplicate id.
   * @throws {RangeError} on negative/non-integer estimatedTokens.
   */
  create(spec: CreatePageSpec): ContextPage {
    const id = spec.id ?? makeContextPageId();
    if (this.#pages.has(id)) {
      throw new PageAlreadyExistsError(id);
    }
    const estimatedTokens = spec.estimatedTokens ?? 0;
    if (!Number.isInteger(estimatedTokens) || estimatedTokens < 0) {
      throw new RangeError("estimatedTokens must be a non-negative integer");
    }

    const page: ContextPage = Object.freeze({
      id,
      kind: spec.kind,
      source: spec.source ? Object.freeze({ ...spec.source }) : undefined,
      contentHash: hashText(spec.text),
      text: spec.text,
      estimatedTokens,
      provenance: Object.freeze({ ...spec.provenance }),
    });
    this.#pages.set(id, page);
    return page;
  }

  get(id: ContextPageId): ContextPage | undefined {
    return this.#pages.get(id);
  }

  has(id: ContextPageId): boolean {
    return this.#pages.has(id);
  }

  /** Number of page OBJECTS held (structural-sharing debug invariant). */
  count(): number {
    return this.#pages.size;
  }
}
