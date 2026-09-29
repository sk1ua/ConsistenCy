/**
 * ImageRegistry — Kernel-owned store of ContextImage records.
 *
 * An image is a page TABLE: a map from page reference → residency, plus fork
 * lineage and a generation counter. The table is the image's ENTIRE effective
 * state — fork() snapshot-copies the table (O(references)) and shares the
 * immutable page objects. Resolution never walks a base chain, so a child's
 * behavior can never change because of a later parent mutation.
 *
 * Image records are Kernel-internal and mutable; every public API returns
 * frozen snapshots instead.
 */

import { randomUUID } from "node:crypto";
import {
  asContextImageId,
  type ContextImageId,
} from "../identity/context-image.js";
import type { ContextPageId, Residency } from "./types.js";
import {
  ImageIdConflictError,
  ImageNotFoundError,
  PageAlreadyAttachedError,
  PageNotAttachedError,
} from "./errors.js";

export function makeContextImageId(): ContextImageId {
  return asContextImageId(`image_${randomUUID()}`);
}

/** Kernel-internal image record (never exposed publicly). */
export interface ImageRecord {
  readonly id: ContextImageId;
  generation: number;
  /** Fork lineage metadata (snapshot semantics; not consulted for resolution). */
  readonly base?: { readonly imageId: ContextImageId; readonly generation: number };
  /** Effective page table: page reference → residency. */
  readonly refs: Map<ContextPageId, Residency>;
}

export class ImageRegistry {
  readonly #images = new Map<ContextImageId, ImageRecord>();

  create(id?: ContextImageId): ImageRecord {
    const imageId = id ?? makeContextImageId();
    if (this.#images.has(imageId)) {
      throw new ImageIdConflictError(imageId);
    }
    const record: ImageRecord = { id: imageId, generation: 1, refs: new Map() };
    this.#images.set(imageId, record);
    return record;
  }

  get(id: ContextImageId): ImageRecord | undefined {
    return this.#images.get(id);
  }

  /** @internal — used by restore() to seed an image from a checkpoint. */
  seed(record: ImageRecord): void {
    this.#images.set(record.id, record);
  }

  count(): number {
    return this.#images.size;
  }

  /**
   * Fork: snapshot-copy the parent's page table and record lineage. Page
   * OBJECTS are shared, never deep-copied.
   */
  fork(parentId: ContextImageId, childId?: ContextImageId): ImageRecord {
    const parent = this.#images.get(parentId);
    if (!parent) {
      throw new ImageNotFoundError(parentId);
    }
    const imageId = childId ?? makeContextImageId();
    if (this.#images.has(imageId)) {
      throw new ImageIdConflictError(imageId);
    }
    const record: ImageRecord = {
      id: imageId,
      generation: 1,
      base: { imageId: parent.id, generation: parent.generation },
      refs: new Map(parent.refs),
    };
    this.#images.set(imageId, record);
    return record;
  }

  /** Attach a page reference (residency defaults to hot). */
  attach(
    imageId: ContextImageId,
    pageId: ContextPageId,
    residency: Residency = "hot",
  ): void {
    const record = this.#require(imageId);
    if (record.refs.has(pageId)) {
      // Attaching an existing reference is ambiguous: callers must detach
      // first or attach a NEW page revision (revision flow).
      throw new PageAlreadyAttachedError(imageId, pageId);
    }
    record.refs.set(pageId, residency);
    record.generation += 1;
  }

  /** Remove a page reference from the image table. */
  detach(imageId: ContextImageId, pageId: ContextPageId): void {
    const record = this.#require(imageId);
    if (!record.refs.has(pageId)) {
      throw new PageNotAttachedError(imageId, pageId);
    }
    record.refs.delete(pageId);
    record.generation += 1;
  }

  /** Set the image-local residency for an attached page. */
  setResidency(imageId: ContextImageId, pageId: ContextPageId, residency: Residency): void {
    const record = this.#require(imageId);
    if (!record.refs.has(pageId)) {
      throw new PageNotAttachedError(imageId, pageId);
    }
    record.refs.set(pageId, residency);
    record.generation += 1;
  }

  #require(imageId: ContextImageId): ImageRecord {
    const record = this.#images.get(imageId);
    if (!record) {
      throw new ImageNotFoundError(imageId);
    }
    return record;
  }
}
