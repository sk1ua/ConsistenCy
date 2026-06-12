import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { redactSensitiveText } from "../../security/redact";

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const SECRET_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "docker-config.json",
  "service-account.json"
]);

export function isSecretPath(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return SECRET_BASENAMES.has(name)
    || name.startsWith(".env.")
    || /\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(name)
    || /^(?:secret|secrets)\./i.test(name);
}

export function resolveWorkspaceFile(workspacePath: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new Error("File path must be relative to the review workspace");
  }
  const root = realpathSync(resolve(workspacePath));
  const candidate = resolve(root, relativePath.replaceAll("/", sep));
  const lexicalRelative = relative(root, candidate);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new Error("File path escapes the review workspace");
  }
  const actual = realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
    throw new Error("File resolves outside the review workspace");
  }
  if (!lstatSync(actual).isFile()) {
    throw new Error("Review context path is not a regular file");
  }
  return actual;
}

export function loadWorkspaceFiles(options: {
  workspacePath: string;
  paths: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): Record<string, string> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  let totalBytes = 0;
  const contents: Record<string, string> = {};

  for (const path of [...new Set(options.paths)]) {
    if (isSecretPath(path)) continue;
    let absolutePath: string;
    try {
      absolutePath = resolveWorkspaceFile(options.workspacePath, path);
    } catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) continue;
      throw error;
    }
    const size = statSync(absolutePath).size;
    if (size > maxFileBytes || totalBytes + size > maxTotalBytes) continue;
    const buffer = readFileSync(absolutePath);
    if (buffer.includes(0)) continue;
    contents[path] = redactSensitiveText(buffer.toString("utf8"));
    totalBytes += size;
  }
  return contents;
}
