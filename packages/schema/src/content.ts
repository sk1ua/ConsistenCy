/**
 * Shared content classification for repository paths.
 *
 * One canonical secret-path gate for every consumer that decides whether a
 * repository path's CONTENT may enter a review context, the model-visible
 * projection, the notebook index, or patch publication. The context loader
 * (apps/api), the review workload's model content policy, and the patch
 * policy all import this — a path excluded here must stay excluded on every
 * read path, not only the one that first filtered it.
 */

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
  const name = relativePath.split(/[\\/]/).pop() ?? "";
  const lower = name.toLowerCase();
  return SECRET_BASENAMES.has(lower)
    || lower.startsWith(".env.")
    || /\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(lower)
    || /^(?:secret|secrets)\./i.test(lower);
}
