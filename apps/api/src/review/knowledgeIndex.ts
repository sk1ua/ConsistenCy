import { join, resolve } from "node:path";

/**
 * Filesystem-safe identifier for a repository.
 *
 * `repositoryFullName` reaches this from a webhook payload or a user-supplied
 * path, so every character outside a conservative allowlist is replaced rather
 * than escaped — that rules out separators, traversal, drive letters, and
 * NTFS stream syntax in one step.
 */
export function repositorySlug(repositoryFullName: string): string {
  const slug = repositoryFullName
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
  return slug.length > 0 ? slug : "unknown";
}

/**
 * Per-repository knowledge database.
 *
 * Kept separate per repository so one project's history can never surface in
 * another project's review prompts.
 */
export function knowledgeIndexPathFor(repositoryFullName: string, workspaceRoot: string): string {
  const root = resolve(workspaceRoot, "..", "knowledge");
  return join(root, `${repositorySlug(repositoryFullName)}.sqlite`);
}
