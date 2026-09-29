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

/**
 * The suffix on credential-material file names.
 *
 * Two shapes are accepted, and nothing else:
 *   1. `<stem>.<suffix>`      | suffix ∈ credential, backup, sql, db, dump
 *   2. `<stem>.enc.<suffix>`  | e.g. `secrets.enc.json`, an encrypted store
 *
 * The list is deliberately closed. An earlier form, `/^(?:secret|secrets)\./`,
 * ignored the extension entirely, so a program module named `secrets.ts` was
 * classified as credential material and silently dropped out of every review
 * context — the file never reached the model and no constraint ever said so.
 */
const CREDENTIAL_NAME_PATTERN = new RegExp(
  [
    "^",
    "(?:secret|secrets|credentials|custom-secrets)", // the credential-looking stem
    "(?:\\.enc(?:\\.encrypted)?)?",                   // optional encryption marker
    "(?:\\.(?:json|ya?ml|toml|env|ini|cfg|conf|properties|txt",   // config formats
    "|backup|bak|sql|sqlite|db|dump))",               // exfiltrated/dumped copies
    "$"
  ].join(""),
  "i"
);

export function isSecretPath(relativePath: string): boolean {
  const name = relativePath.split(/[\\/]/).pop() ?? "";
  const lower = name.toLowerCase();
  return SECRET_BASENAMES.has(lower)
    || /^\.env(?:\.|$)/i.test(lower)
    // Extension-only rule: any `<name>.key` / `.pem` / `.p12` file is key material.
    || /\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(lower)
    || CREDENTIAL_NAME_PATTERN.test(lower);
}
