/**
 * Checkpoint/restore tests — AC-CTX-12 … AC-CTX-14.
 *
 * Checkpoints are serializable, self-contained, and restore FAILS CLOSED:
 * a stored contentHash that does not match its restored text is rejected.
 */

import { describe, it, expect } from "vitest";
import {
  ContextManager,
  CheckpointCorruptionError,
  CheckpointFormatError,
  ImageIdConflictError,
  asContextImageId,
  asContextPageId,
  type ContextImageId,
  type ContextPageId,
} from "../index.js";

function makePage(
  manager: ContextManager,
  id: string,
  kind: "policy" | "task" | "source" | "evidence" | "summary",
  tokens = 10,
): ContextPageId {
  return manager.createPage({
    id: asContextPageId(id),
    kind,
    text: `content of ${id}`,
    estimatedTokens: tokens,
    provenance: { producer: "test", producerVersion: "1.0.0" },
  });
}

function semanticView(manager: ContextManager, imageId: ContextImageId) {
  return manager.resolve(imageId).map((e) => ({
    pageId: e.page.id,
    kind: e.page.kind,
    residency: e.residency,
    hash: e.page.contentHash,
    text: e.page.text,
  }));
}

function buildRichImage(manager: ContextManager) {
  const imageId = manager.createImage();
  const pinned = makePage(manager, "pol", "policy", 100);
  const hot = makePage(manager, "src", "source", 50);
  const cold = makePage(manager, "mem", "summary", 30);
  const evicted = makePage(manager, "ast", "evidence", 20);
  manager.attach(imageId, pinned, "pinned");
  manager.attach(imageId, hot, "hot");
  manager.attach(imageId, cold, "cold");
  manager.attach(imageId, evicted, "hot");
  manager.evict(imageId, evicted);
  return { manager, imageId };
}

describe("ContextManager — checkpoint / restore", () => {
  it("AC-CTX-12: checkpoint → restore round-trip preserves effective image state", () => {
    const { manager, imageId } = buildRichImage(new ContextManager());
    const checkpoint = manager.checkpoint(imageId);
    const serialized = manager.serializeCheckpoint(checkpoint);

    // Restore into a FRESH manager (full serialization independence).
    const fresh = new ContextManager();
    const restoredId = fresh.restore(serialized);

    expect(semanticView(fresh, restoredId)).toEqual(semanticView(manager, imageId));
    expect(fresh.render(restoredId)).toEqual(manager.render(imageId));
    expect(fresh.getImage(restoredId)!.generation).toBe(
      manager.getImage(imageId)!.generation,
    );
  });

  it("AC-CTX-13: corrupted checkpoints are rejected (fail closed)", () => {
    const { manager, imageId } = buildRichImage(new ContextManager());
    const serialized = manager.serializeCheckpoint(manager.checkpoint(imageId));

    // Tamper 1: stored contentHash no longer matches the text.
    const tamperedHash = JSON.parse(serialized) as {
      pages: Array<{ contentHash: string }>;
    };
    tamperedHash.pages[0]!.contentHash = "0".repeat(64);
    expect(() => manager.restore(JSON.stringify(tamperedHash))).toThrow(
      CheckpointCorruptionError,
    );

    // Tamper 2: text changed without re-hashing.
    const tamperedText = JSON.parse(serialized) as {
      pages: Array<{ text: string }>;
    };
    tamperedText.pages[1]!.text = "corrupted content";
    expect(() => manager.restore(JSON.stringify(tamperedText))).toThrow(
      CheckpointCorruptionError,
    );

    // Tamper 3: not JSON at all.
    expect(() => manager.restore("{not json")).toThrow(CheckpointFormatError);

    // Tamper 4: wrong format marker.
    const wrongFormat = JSON.parse(serialized) as { format: string };
    wrongFormat.format = "other.format.v9";
    expect(() => manager.restore(JSON.stringify(wrongFormat))).toThrow(CheckpointFormatError);

    // Tamper 5: image references an unknown page.
    const unknownRef = JSON.parse(serialized) as {
      image: { pages: Array<{ pageId: string; residency: string }> };
    };
    unknownRef.image.pages.push({ pageId: "page_ghost", residency: "hot" });
    expect(() => manager.restore(JSON.stringify(unknownRef))).toThrow(CheckpointFormatError);

    // Nothing was partially restored by any failed attempt.
    expect(semanticView(manager, imageId)).toEqual(semanticView(manager, imageId));
    expect(manager.resolve(imageId)).toHaveLength(4);
  });

  it("AC-CTX-14: checkpoint/restore of a forked image preserves child overlay semantics", () => {
    const { manager, imageId } = buildRichImage(new ContextManager());
    const childId = manager.fork(imageId);
    const extra = makePage(manager, "extra", "evidence", 5);
    manager.attach(childId, extra, "hot");
    manager.setResidency(childId, asContextPageId("src"), "pinned");

    const checkpoint = manager.checkpoint(childId);
    const fresh = new ContextManager();
    const restoredId = fresh.restore(manager.serializeCheckpoint(checkpoint));

    expect(semanticView(fresh, restoredId)).toEqual(semanticView(manager, childId));
    // Fork lineage preserved.
    expect(fresh.getImage(restoredId)!.base).toEqual(manager.getImage(childId)!.base);
    // Overlay residency preserved (src is pinned in the child).
    expect(fresh.resolve(restoredId).find((e) => e.page.id === asContextPageId("src"))!.residency).toBe(
      "pinned",
    );
    expect(fresh.resolve(restoredId).some((e) => e.page.id === extra)).toBe(true);
  });

  it("restore identity and collision semantics are explicit", () => {
    const { manager, imageId } = buildRichImage(new ContextManager());
    const checkpoint = manager.checkpoint(imageId);
    const serialized = manager.serializeCheckpoint(checkpoint);

    // The checkpoint's own id is free in a fresh manager → reused.
    const fresh = new ContextManager();
    const restoredId = fresh.restore(serialized);
    expect(restoredId).toBe(imageId);

    // Restoring again into the same manager → id conflict (fail closed).
    expect(() => fresh.restore(serialized)).toThrow(ImageIdConflictError);

    // Restore under an explicit replacement identity.
    const fresh2 = new ContextManager();
    const alt = fresh2.restore(serialized, { imageId: asContextImageId("image_replacement") });
    expect(alt).toBe("image_replacement");
  });

  it("page id collision with different content is rejected; identical content reuses", () => {
    const { manager, imageId } = buildRichImage(new ContextManager());
    const serialized = manager.serializeCheckpoint(manager.checkpoint(imageId));

    const fresh = new ContextManager();
    // Pre-seed a page with the SAME id but DIFFERENT content.
    fresh.createPage({
      id: asContextPageId("pol"),
      kind: "policy",
      text: "other content entirely",
      provenance: { producer: "test", producerVersion: "1.0.0" },
    });
    expect(() => fresh.restore(serialized)).toThrow(CheckpointCorruptionError);

    // Pre-seed a page with identical content → reuse succeeds.
    const fresh2 = new ContextManager();
    fresh2.createPage({
      id: asContextPageId("pol"),
      kind: "policy",
      text: "content of pol",
      provenance: { producer: "test", producerVersion: "1.0.0" },
    });
    expect(() => fresh2.restore(serialized)).not.toThrow();
  });
});
