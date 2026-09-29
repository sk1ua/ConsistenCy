import { isAbsolute, normalize } from "node:path";
import { isSecretPath } from "../context/fileLoader";

/** Paths a suggested patch may never touch, whatever the model proposes. */
const FORBIDDEN_PREFIXES = [
  ".git/",
  ".github/",
  ".consistency/",
  "node_modules/"
];

const FORBIDDEN_EXACT = new Set([
  ".gitignore",
  ".npmrc",
  ".env",
  ".env.example",
  "package-lock.json",
  "uv.lock"
]);

const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 20;

export type PatchViolation = {
  code:
    | "EMPTY_PATCH"
    | "TOO_LARGE"
    | "TOO_MANY_FILES"
    | "MALFORMED"
    | "PATH_TRAVERSAL"
    | "FORBIDDEN_PATH"
    | "SECRET_PATH"
    | "PATH_OUTSIDE_REVIEW";
  message: string;
  path?: string;
};

export type PatchPolicyOptions = {
  /**
   * Files the review actually looked at. A patch may only touch these — a fix
   * for code nobody reviewed has no evidence behind it.
   */
  reviewedPaths: readonly string[];
  maxPatchBytes?: number;
  maxFiles?: number;
};

export type PatchInspection = {
  ok: boolean;
  touchedPaths: string[];
  violations: PatchViolation[];
};

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const OLD_FILE = /^--- (?:a\/)?(.+)$/;
const NEW_FILE = /^\+\+\+ (?:b\/)?(.+)$/;

function normalisePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^"|"$/g, "");
}

function isTraversal(path: string): boolean {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return true;
  const normalised = normalize(path).replace(/\\/g, "/");
  return normalised.startsWith("../") || normalised === ".." || normalised.includes("/../");
}

/**
 * Structural and policy inspection of a model-proposed unified diff.
 *
 * This runs *before* anything is applied anywhere. A suggested fix is untrusted
 * content: the model that wrote it may itself have been steered by text inside
 * the repository under review, so the patch is constrained to the files that
 * were actually reviewed and kept away from CI config, secrets, and lockfiles.
 */
export function inspectPatch(patch: string, options: PatchPolicyOptions): PatchInspection {
  const violations: PatchViolation[] = [];
  const touched = new Set<string>();

  if (patch.trim().length === 0) {
    return {
      ok: false,
      touchedPaths: [],
      violations: [{ code: "EMPTY_PATCH", message: "Patch is empty" }]
    };
  }

  const maxBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  if (Buffer.byteLength(patch, "utf8") > maxBytes) {
    violations.push({
      code: "TOO_LARGE",
      message: `Patch exceeds ${maxBytes} bytes`
    });
  }

  let sawHunk = false;
  for (const line of patch.split("\n")) {
    const header = DIFF_HEADER.exec(line);
    if (header !== null) {
      touched.add(normalisePath(header[1] ?? ""));
      touched.add(normalisePath(header[2] ?? ""));
      continue;
    }
    if (line.startsWith("@@")) {
      sawHunk = true;
      continue;
    }
    const oldFile = OLD_FILE.exec(line);
    if (oldFile !== null && !line.startsWith("--- /dev/null")) {
      touched.add(normalisePath(oldFile[1] ?? ""));
      continue;
    }
    const newFile = NEW_FILE.exec(line);
    if (newFile !== null && !line.startsWith("+++ /dev/null")) {
      touched.add(normalisePath(newFile[1] ?? ""));
    }
  }

  touched.delete("");
  touched.delete("/dev/null");

  if (!sawHunk) {
    violations.push({
      code: "MALFORMED",
      message: "Patch contains no unified diff hunks"
    });
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (touched.size > maxFiles) {
    violations.push({
      code: "TOO_MANY_FILES",
      message: `Patch touches ${touched.size} files, more than the ${maxFiles} allowed`
    });
  }

  const reviewed = new Set(options.reviewedPaths.map(normalisePath));
  for (const path of touched) {
    if (isTraversal(path)) {
      violations.push({ code: "PATH_TRAVERSAL", message: `Path escapes the repository: ${path}`, path });
      continue;
    }
    if (isSecretPath(path)) {
      violations.push({ code: "SECRET_PATH", message: `Patch touches a secret path: ${path}`, path });
      continue;
    }
    if (FORBIDDEN_EXACT.has(path) || FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))) {
      violations.push({ code: "FORBIDDEN_PATH", message: `Patch touches a protected path: ${path}`, path });
      continue;
    }
    if (!reviewed.has(path)) {
      violations.push({
        code: "PATH_OUTSIDE_REVIEW",
        message: `Patch touches '${path}', which was not part of the reviewed change`,
        path
      });
    }
  }

  return {
    ok: violations.length === 0,
    touchedPaths: [...touched].sort(),
    violations
  };
}
