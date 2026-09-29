/**
 * ContextPage + resolution tests — AC-CTX-1 … AC-CTX-3.
 */

import { describe, it, expect } from "vitest";
import {
  ContextManager,
  asContextImageId,
  asContextPageId,
  hashText,
  type ContextPageKind,
  type CreatePageSpec,
} from "../index.js";

function pageSpec(overrides: {
  id: string;
  kind: ContextPageKind;
  text?: string;
  estimatedTokens?: number;
}): CreatePageSpec {
  return {
    text: `content of ${overrides.id}`,
    provenance: { producer: "test", producerVersion: "1.0.0" },
    ...overrides,
    id: asContextPageId(overrides.id),
  };
}

describe("ContextPage — AC-CTX-1: deterministic content hashing", () => {
  it("the same text hashes identically, and equals sha256(text)", () => {
    const manager = new ContextManager();
    const a = manager.createPage(pageSpec({ id: "p1", kind: "source", text: "same text" }));
    const b = manager.createPage(pageSpec({ id: "p2", kind: "source", text: "same text" }));
    const c = manager.createPage(pageSpec({ id: "p3", kind: "source", text: "different" }));

    expect(manager.getPage(a)!.contentHash).toBe(hashText("same text"));
    expect(manager.getPage(a)!.contentHash).toBe(manager.getPage(b)!.contentHash);
    expect(manager.getPage(a)!.contentHash).not.toBe(manager.getPage(c)!.contentHash);
    expect(manager.getPage(a)!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashing is stable across manager instances", () => {
    const m1 = new ContextManager();
    const m2 = new ContextManager();
    const p1 = m1.createPage(pageSpec({ id: "p1", kind: "policy", text: "policy text" }));
    const p2 = m2.createPage(pageSpec({ id: "p2", kind: "policy", text: "policy text" }));
    expect(m1.getPage(p1)!.contentHash).toBe(m2.getPage(p2)!.contentHash);
  });

  it("rejects duplicate page ids and invalid token estimates", () => {
    const manager = new ContextManager();
    manager.createPage(pageSpec({ id: "p1", kind: "policy" }));
    expect(() => manager.createPage(pageSpec({ id: "p1", kind: "policy" }))).toThrow(/already exists/);
    expect(() =>
      manager.createPage(pageSpec({ id: "p2", kind: "policy", estimatedTokens: -1 })),
    ).toThrow(RangeError);
    expect(() =>
      manager.createPage(pageSpec({ id: "p3", kind: "policy", estimatedTokens: 1.5 })),
    ).toThrow(RangeError);
  });
});

describe("ContextManager — AC-CTX-2: public snapshots cannot mutate Kernel state", () => {
  it("page/image/resolve/working-set/render views are frozen", () => {
    const manager = new ContextManager();
    const pageId = manager.createPage(pageSpec({ id: "p1", kind: "policy", text: "policy" }));
    const imageId = manager.createImage();
    manager.attach(imageId, pageId, "pinned");

    const page = manager.getPage(pageId)!;
    const image = manager.getImage(imageId)!;
    const resolved = manager.resolve(imageId);
    const workingSet = manager.workingSet(imageId);
    const rendered = manager.render(imageId);

    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.provenance)).toBe(true);
    expect(Object.isFrozen(image)).toBe(true);
    expect(Object.isFrozen(image.pages)).toBe(true);
    expect(Object.isFrozen(image.pages[0]!)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved[0]!)).toBe(true);
    expect(Object.isFrozen(workingSet)).toBe(true);
    expect(Object.isFrozen(workingSet.pages)).toBe(true);
    expect(Object.isFrozen(rendered)).toBe(true);
    expect(Object.isFrozen(rendered.pages)).toBe(true);
    expect(Object.isFrozen(rendered.pages[0]!)).toBe(true);

    // Mutation attempts throw (ESM strict mode) and change nothing.
    expect(() => {
      (page as { text: string }).text = "hacked";
    }).toThrow(TypeError);
    expect(() => {
      (image.pages as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (resolved as unknown as unknown[]).pop();
    }).toThrow(TypeError);

    expect(manager.getPage(pageId)!.text).toBe("policy");
    expect(manager.getImage(imageId)!.pages).toHaveLength(1);
    expect(manager.resolve(imageId)).toHaveLength(1);
  });
});

describe("ContextManager — AC-CTX-3: deterministic image resolution", () => {
  it("resolves attached pages in canonical kind order, independent of attach order", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();

    // Scrambled attach order.
    const source = manager.createPage(pageSpec({ id: "src-1", kind: "source" }));
    const policy = manager.createPage(pageSpec({ id: "pol-1", kind: "policy" }));
    const ast = manager.createPage(pageSpec({ id: "ast-1", kind: "ast" }));
    manager.attach(imageId, ast, "hot");
    manager.attach(imageId, policy, "hot");
    manager.attach(imageId, source, "hot");

    const expected = [
      { pageId: policy, kind: "policy" },
      { pageId: source, kind: "source" },
      { pageId: ast, kind: "ast" },
    ];
    const first = manager.resolve(imageId).map((e) => ({ pageId: e.page.id, kind: e.page.kind }));
    const second = manager.resolve(imageId).map((e) => ({ pageId: e.page.id, kind: e.page.kind }));

    expect(first).toEqual(expected);
    expect(second).toEqual(first); // repeated resolution is identical
  });

  it("typed errors for unknown/duplicate/missing references", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pageId = manager.createPage(pageSpec({ id: "p1", kind: "policy" }));

    expect(() => manager.attach(imageId, asContextPageId("ghost"), "hot")).toThrow(/Unknown ContextPage/);
    manager.attach(imageId, pageId, "hot");
    expect(() => manager.attach(imageId, pageId, "hot")).toThrow(/already attached/);
    expect(() => manager.detach(imageId, asContextPageId("ghost"))).toThrow(/not attached/);
    expect(() => manager.resolve(asContextImageId("no-image"))).toThrow(/Unknown ContextImage/);
    expect(() => manager.workingSet(asContextImageId("no-image"))).toThrow(/Unknown ContextImage/);
    expect(() => manager.render(asContextImageId("no-image"))).toThrow(/Unknown ContextImage/);
  });
});
