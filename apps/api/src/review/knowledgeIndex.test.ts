import { isAbsolute, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { knowledgeIndexPathFor, repositorySlug } from "./knowledgeIndex";

const WORKSPACES = "C:/consistency/.consistency/workspaces";
const KNOWLEDGE_ROOT = resolve(WORKSPACES, "..", "knowledge");

describe("repositorySlug", () => {
  it("keeps a normal repository name readable", () => {
    expect(repositorySlug("sk1ua/ConsistenCy")).toBe("sk1ua_ConsistenCy");
  });

  it("neutralises separators and traversal", () => {
    // Repository names arrive from webhook payloads and user-supplied paths.
    for (const name of ["../../etc/passwd", "..\\..\\windows", "a/../../b", "/absolute/path"]) {
      const slug = repositorySlug(name);
      expect(slug, name).not.toContain("/");
      expect(slug, name).not.toContain("\\");
      expect(slug.startsWith("."), name).toBe(false);
    }
  });

  it("neutralises drive letters and NTFS stream syntax", () => {
    expect(repositorySlug("C:evil")).not.toContain(":");
    expect(repositorySlug("file.txt:stream")).not.toContain(":");
  });

  it("falls back rather than producing an empty name", () => {
    expect(repositorySlug("")).toBe("unknown");
    expect(repositorySlug("///")).not.toBe("");
  });

  it("bounds the length", () => {
    expect(repositorySlug("a".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe("knowledgeIndexPathFor", () => {
  it("places the database in a sibling knowledge directory", () => {
    const path = knowledgeIndexPathFor("sk1ua/ConsistenCy", WORKSPACES);

    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith(KNOWLEDGE_ROOT + sep)).toBe(true);
    expect(path.endsWith("sk1ua_ConsistenCy.sqlite")).toBe(true);
  });

  it("gives different repositories different databases", () => {
    // One project's history must never surface in another project's prompts.
    expect(knowledgeIndexPathFor("owner/alpha", WORKSPACES))
      .not.toBe(knowledgeIndexPathFor("owner/beta", WORKSPACES));
  });

  it("keeps a hostile repository name inside the knowledge directory", () => {
    for (const name of ["../../../etc/passwd", "..\\..\\evil", "/etc/shadow"]) {
      const path = knowledgeIndexPathFor(name, WORKSPACES);
      expect(path.startsWith(KNOWLEDGE_ROOT + sep), name).toBe(true);
    }
  });
});
