import type { DiffHunk, FileChangeStatus, VcsChangedFile } from "@consistency/schema";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

type Draft = {
  oldPath?: string;
  newPath?: string;
  status?: FileChangeStatus;
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

function newDraft(): Draft {
  return { binary: false, additions: 0, deletions: 0, hunks: [] };
}

function stripPrefix(value: string): string | undefined {
  if (value === "/dev/null") return undefined;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/**
 * Recovers both paths from a `diff --git a/X b/Y` header.
 *
 * Needed because binary and mode-only diffs carry no `---`/`+++` lines. Git
 * does not quote paths containing spaces here, so the split point is ambiguous;
 * the identical-sides case is tried first (by far the most common), then the
 * last boundary. Renames are unaffected either way since `rename from`/
 * `rename to` provide exact paths.
 */
function parseDiffGitPaths(line: string): { oldPath?: string; newPath?: string } {
  const body = line.slice("diff --git ".length);
  if (!body.startsWith("a/")) return {};

  for (let index = 0; index < body.length; index += 1) {
    if (!body.startsWith(" b/", index)) continue;
    const left = body.slice(2, index);
    const right = body.slice(index + 3);
    if (left === right && left.length > 0) return { oldPath: left, newPath: right };
  }

  const boundary = body.lastIndexOf(" b/");
  if (boundary === -1) return {};
  const oldPath = body.slice(2, boundary);
  const newPath = body.slice(boundary + 3);
  if (oldPath.length === 0 || newPath.length === 0) return {};
  return { oldPath, newPath };
}

function resolveStatus(draft: Draft): FileChangeStatus {
  if (draft.status !== undefined) return draft.status;
  const { oldMode, newMode } = draft;
  if (oldMode !== undefined && newMode !== undefined && oldMode !== newMode) {
    const wasSymlink = oldMode.startsWith("120");
    const isSymlink = newMode.startsWith("120");
    if (wasSymlink !== isSymlink) return "type_changed";
  }
  return "modified";
}

function finalize(draft: Draft, into: VcsChangedFile[]): void {
  const path = draft.newPath ?? draft.oldPath;
  if (path === undefined) return;
  const status = resolveStatus(draft);
  const file: VcsChangedFile = {
    path,
    status,
    additions: draft.additions,
    deletions: draft.deletions,
    binary: draft.binary,
    hunks: draft.hunks
  };
  if ((status === "renamed" || status === "copied") && draft.oldPath !== undefined) {
    file.previousPath = draft.oldPath;
  }
  into.push(file);
}

/**
 * Parses `git diff --patch` output into schema-shaped changed files.
 *
 * Callers must pin `--src-prefix=a/ --dst-prefix=b/`, otherwise repository
 * config (`diff.noprefix`, `diff.mnemonicPrefix`) changes the path prefixes and
 * silently corrupts every parsed path.
 *
 * Hunk bodies are consumed by the line counts declared in the `@@` header
 * rather than by scanning for the next structural marker, because a deletion
 * line such as `--- a/x` is indistinguishable from a file header otherwise.
 */
export function parseUnifiedDiff(patch: string): VcsChangedFile[] {
  const files: VcsChangedFile[] = [];
  if (patch.trim().length === 0) return files;

  const lines = patch.split("\n");
  let draft: Draft | undefined;
  let hunkLines: string[] = [];
  let hunkHeader = "";
  let hunkMeta: { oldStart: number; oldLines: number; newStart: number; newLines: number } | undefined;
  let remainingOld = 0;
  let remainingNew = 0;

  const closeHunk = () => {
    if (draft === undefined || hunkMeta === undefined) return;
    draft.hunks.push({
      header: hunkHeader,
      oldStart: hunkMeta.oldStart,
      oldLines: hunkMeta.oldLines,
      newStart: hunkMeta.newStart,
      newLines: hunkMeta.newLines,
      content: hunkLines.join("\n")
    });
    hunkMeta = undefined;
    hunkLines = [];
  };

  const inHunk = () => hunkMeta !== undefined && (remainingOld > 0 || remainingNew > 0);

  for (const line of lines) {
    if (inHunk()) {
      const marker = line.charAt(0);
      if (marker === "\\") {
        hunkLines.push(line);
        continue;
      }
      if (marker === " " || line === "") {
        hunkLines.push(line);
        remainingOld -= 1;
        remainingNew -= 1;
        continue;
      }
      if (marker === "+") {
        hunkLines.push(line);
        remainingNew -= 1;
        if (draft !== undefined) draft.additions += 1;
        continue;
      }
      if (marker === "-") {
        hunkLines.push(line);
        remainingOld -= 1;
        if (draft !== undefined) draft.deletions += 1;
        continue;
      }
      // Malformed body: stop consuming and reinterpret as structure.
      remainingOld = 0;
      remainingNew = 0;
    }

    if (hunkMeta !== undefined && !inHunk()) closeHunk();

    if (line.startsWith("diff --git ")) {
      if (draft !== undefined) finalize(draft, files);
      draft = newDraft();
      const { oldPath, newPath } = parseDiffGitPaths(line);
      draft.oldPath = oldPath;
      draft.newPath = newPath;
      continue;
    }
    if (draft === undefined) continue;

    if (line.startsWith("new file mode ")) {
      draft.status = "added";
      draft.newMode = line.slice("new file mode ".length).trim();
    } else if (line.startsWith("deleted file mode ")) {
      draft.status = "deleted";
      draft.oldMode = line.slice("deleted file mode ".length).trim();
    } else if (line.startsWith("old mode ")) {
      draft.oldMode = line.slice("old mode ".length).trim();
    } else if (line.startsWith("new mode ")) {
      draft.newMode = line.slice("new mode ".length).trim();
    } else if (line.startsWith("rename from ")) {
      draft.status = "renamed";
      draft.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      draft.status = "renamed";
      draft.newPath = line.slice("rename to ".length);
    } else if (line.startsWith("copy from ")) {
      draft.status = "copied";
      draft.oldPath = line.slice("copy from ".length);
    } else if (line.startsWith("copy to ")) {
      draft.status = "copied";
      draft.newPath = line.slice("copy to ".length);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      draft.binary = true;
    } else if (line.startsWith("--- ")) {
      const resolved = stripPrefix(line.slice(4));
      if (resolved === undefined) draft.status ??= "added";
      else draft.oldPath ??= resolved;
    } else if (line.startsWith("+++ ")) {
      const resolved = stripPrefix(line.slice(4));
      if (resolved === undefined) draft.status ??= "deleted";
      else draft.newPath ??= resolved;
    } else {
      const match = HUNK_HEADER.exec(line);
      if (match === null) continue;
      hunkHeader = line;
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      hunkMeta = { oldStart, oldLines, newStart, newLines };
      hunkLines = [];
      remainingOld = oldLines;
      remainingNew = newLines;
      if (!inHunk()) closeHunk();
    }
  }

  if (hunkMeta !== undefined) closeHunk();
  if (draft !== undefined) finalize(draft, files);
  return files;
}

/** Splits NUL-delimited git output, dropping the trailing empty field. */
export function splitNulRecords(value: string): string[] {
  return value.split("\0").filter((record) => record.length > 0);
}
