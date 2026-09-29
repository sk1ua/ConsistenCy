/**
 * Model content policy tests (audit P0-01).
 *
 * The synthetic token/keys are invalid shapes reserved for tests; no real
 * credential material appears in this file.
 */

import { describe, expect, it } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { isSecretPath } from "@consistency/schema";
import {
  applyModelContentPolicy,
  redactModelVisibleText,
} from "../context/content-policy.js";
import { FAKE_TOKEN, HEAD_FILE } from "./fixtures.js";

function makeContext(overrides: Partial<PRReviewContext> = {}): PRReviewContext {
  return {
    jobId: "job_policy",
    source: "github_pr",
    repositoryFullName: "test/example",
    pullRequestNumber: 7,
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    changedFiles: [
      {
        path: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: `@@ -1,2 +1,2 @@\n-old\n+export const token = "${FAKE_TOKEN}";`,
      },
      {
        path: ".env.production",
        status: "added",
        additions: 2,
        deletions: 0,
        changes: 2,
        patch: "@@ -0,0 +1,2 @@\n+API_KEY=supersecretvalue123\n+OTHER=1",
      },
    ],
    diff: `diff --git a/src/index.ts b/src/index.ts\n@@ -1,2 +1,2 @@\n-old\n+export const token = "${FAKE_TOKEN}";`,
    fileContents: {
      "src/index.ts": HEAD_FILE,
      ".env.production": "API_KEY=supersecretvalue123\nOTHER=1",
    },
    baseFileContents: { "src/index.ts": "const legacy = 1;" },
    projectMetadata: { "package.json": "{}" },
    workspacePath: "/tmp/review-workspace",
    ...overrides,
  };
}

describe("isSecretPath (canonical gate)", () => {
  it("classifies the loader's secret-path vocabulary", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("config/.env.production")).toBe(true);
    expect(isSecretPath("keys/app.pem")).toBe(true);
    expect(isSecretPath(".npmrc")).toBe(true);
    expect(isSecretPath("secrets.yaml")).toBe(true);
    expect(isSecretPath("src/index.ts")).toBe(false);
    expect(isSecretPath("docs/credentials-guide.md")).toBe(false);
  });
});

describe("redactModelVisibleText", () => {
  it("masks token-shaped values", () => {
    const text = `const a = "${FAKE_TOKEN}";\nAuthorization: Bearer abc123def456ghi789jkl\nsk-${"A".repeat(30)}`;
    const redacted = redactModelVisibleText(text);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).not.toContain("abc123def456ghi789jkl");
    expect(redacted).not.toContain(`sk-${"A".repeat(30)}`);
    expect(redacted).toContain("[REDACTED]");
  });

  it("masks key=value secret assignments and URL credentials", () => {
    const redacted = redactModelVisibleText(
      "api_key = \"hk7s36abc\"\nfetch(\"https://user:pass@example.com/x\")",
    );
    expect(redacted).not.toContain("hk7s36abc");
    expect(redacted).not.toContain("user:pass@example.com");
    expect(redacted).toContain("api_key=[REDACTED]");
  });

  it("preserves line counts, including multi-line private key blocks", () => {
    const block = [
      "line-before",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1",
      "MIIEowIBAAKCAQEA2",
      "-----END RSA PRIVATE KEY-----",
      "line-after",
    ].join("\n");
    const redacted = redactModelVisibleText(block);
    expect(redacted.split("\n")).toHaveLength(6);
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA1");
    expect(redacted).toContain("line-before");
    expect(redacted).toContain("line-after");
  });

  it("is idempotent", () => {
    const once = redactModelVisibleText(`token: "${FAKE_TOKEN}"`);
    expect(redactModelVisibleText(once)).toBe(once);
  });
});

describe("applyModelContentPolicy", () => {
  it("drops secret-path contents and patches while keeping the changed-file entry", () => {
    const sanitized = applyModelContentPolicy(makeContext());

    expect(sanitized.fileContents[".env.production"]).toBeUndefined();
    expect(sanitized.fileContents["src/index.ts"]).toBeDefined();
    const secretEntry = sanitized.changedFiles.find((f) => f.path === ".env.production");
    expect(secretEntry).toBeDefined();
    expect(secretEntry!.patch).toBeUndefined();
  });

  it("redacts every model-visible text surface", () => {
    const sanitized = applyModelContentPolicy(makeContext());

    expect(sanitized.fileContents["src/index.ts"]).not.toContain(FAKE_TOKEN);
    expect(sanitized.diff).not.toContain(FAKE_TOKEN);
    expect(sanitized.changedFiles[0]!.patch).not.toContain(FAKE_TOKEN);
  });

  it("does not mutate the input context (analysis keeps raw bytes)", () => {
    const context = makeContext();
    applyModelContentPolicy(context);
    expect(context.fileContents["src/index.ts"]).toContain(FAKE_TOKEN);
    expect(context.diff).toContain(FAKE_TOKEN);
    expect(context.fileContents[".env.production"]).toBeDefined();
  });

  it("keeps line counts stable so grounding line numbers survive", () => {
    const context = makeContext();
    const sanitized = applyModelContentPolicy(context);
    expect(sanitized.fileContents["src/index.ts"]!.split("\n")).toHaveLength(
      context.fileContents["src/index.ts"]!.split("\n").length,
    );
  });
});

/**
 * Diff-section gate (P0-01 acceptance gap, 2026-09-19 supervision finding):
 * `context.diff` is a pre-concatenated string, so pattern redaction alone
 * cannot honor the secret-PATH rule — a `.env` section whose values match no
 * token regex (custom assignment names, marker blobs) would still reach the
 * model through the DIFF prompt segment. These fixtures use values that no
 * pattern in redactModelVisibleText matches, isolating the structural gate.
 */
const DIFF_ONLY_SECRET_VALUES = [
  "INTERNAL_SERVICE_TICKET=qq-771234",
  "zz-nonregex-secret-42",
  "MIIBrandomBLOBnotAPattern",
];

function makeMixedLocalFormatDiff(): string {
  // Local working-tree builder format: `--- a/x` / `+++ b/x` pairs, no
  // `diff --git` line. Mix: normal file + added .env + deleted secret + a
  // normal file whose hunk contains a `-- note` removed line (must not split).
  return [
    "--- a/src/index.ts",
    "+++ b/src/index.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+export const token = \"placeholder\";",
    "--- a/.env",
    "+++ b/.env",
    "@@ -0,0 +1,2 @@",
    "+INTERNAL_SERVICE_TICKET=qq-771234",
    "+zz-nonregex-secret-42",
    "--- a/secrets.backup",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-MIIBrandomBLOBnotAPattern",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,2 +1,2 @@",
    "--- plain note",
    "+-- updated note",
  ].join("\n");
}

function makeMixedGitFormatDiff(): string {
  // GitHub `raw_diff` format: `diff --git` headers, including a rename whose
  // previous path is secret and whose new path is NOT (and vice versa).
  return [
    "diff --git a/.env b/.env",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1 @@",
    "+INTERNAL_SERVICE_TICKET=qq-771234",
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    "-const old = 1;",
    "+const updated = 2;",
    "diff --git a/.env.staging b/config/runtime.conf",
    "similarity index 95%",
    "rename from .env.staging",
    "rename to config/runtime.conf",
    "@@ -1 +1 @@",
    "-zz-nonregex-secret-42",
    "+zz-nonregex-secret-42-renamed",
    "diff --git a/docs/old.md b/docs/new.md",
    "rename from docs/old.md",
    "rename to docs/new.md",
    "@@ -1 +1 @@",
    "-# Old",
    "+# New",
  ].join("\n");
}

describe("applyModelContentPolicy — secret diff sections (P0-01 diff gate)", () => {
  it("drops whole secret-path sections from local-format diffs, keeps normal sections", () => {
    const sanitized = applyModelContentPolicy(makeContext({
      diff: makeMixedLocalFormatDiff(),
      changedFiles: [
        {
          path: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
          patch: "@@ -1,2 +1,2 @@\n-old\n+export const token = \"placeholder\";",
        },
        { path: ".env", status: "added", additions: 2, deletions: 0, changes: 2 },
        { path: "secrets.backup", status: "removed", additions: 0, deletions: 1, changes: 1 },
      ],
    }));

    for (const value of DIFF_ONLY_SECRET_VALUES) {
      expect(sanitized.diff).not.toContain(value);
    }
    expect(sanitized.diff).not.toContain("--- a/.env");
    expect(sanitized.diff).not.toContain("+++ b/.env");
    expect(sanitized.diff).not.toContain("--- a/secrets.backup");
    // Normal sections survive with their hunk structure intact...
    expect(sanitized.diff).toContain("--- a/src/index.ts");
    expect(sanitized.diff).toContain("@@ -1,2 +1,2 @@");
    expect(sanitized.diff).toContain("--- a/notes.md");
    expect(sanitized.diff).toContain("+-- updated note");
    // ...a removed `-- note` line inside a hunk must not be mistaken for a header.
    expect(sanitized.diff).toContain("--- plain note");
  });

  it("drops secret sections from git-format diffs, including renames via previousPath", () => {
    const sanitized = applyModelContentPolicy(makeContext({ diff: makeMixedGitFormatDiff() }));

    for (const value of DIFF_ONLY_SECRET_VALUES) {
      expect(sanitized.diff).not.toContain(value);
    }
    expect(sanitized.diff).not.toContain("diff --git a/.env b/.env");
    expect(sanitized.diff).not.toContain("rename from .env.staging");
    expect(sanitized.diff).not.toContain("zz-nonregex-secret-42-renamed");
    expect(sanitized.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(sanitized.diff).toContain("+const updated = 2;");
    expect(sanitized.diff).toContain("diff --git a/docs/old.md b/docs/new.md");
    expect(sanitized.diff).toContain("# New");
  });

  it("still pattern-redacts token-shaped values inside surviving sections", () => {
    const sanitized = applyModelContentPolicy(makeContext({
      diff: [
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        `-export const token = "${FAKE_TOKEN}";`,
        `+export const token = "${FAKE_TOKEN}";`,
      ].join("\n"),
    }));
    expect(sanitized.diff).not.toContain(FAKE_TOKEN);
    expect(sanitized.diff).toContain("[REDACTED]");
  });

  it("projection is idempotent", () => {
    const context = makeContext({ diff: makeMixedGitFormatDiff() });
    const once = applyModelContentPolicy(context);
    expect(applyModelContentPolicy(once).diff).toBe(once.diff);
  });

  it("does not mutate the input diff (analysis keeps raw bytes)", () => {
    const diff = makeMixedLocalFormatDiff();
    applyModelContentPolicy(makeContext({ diff }));
    expect(diff).toContain("INTERNAL_SERVICE_TICKET=qq-771234");
  });

  it("drops secret sections even when line endings are CRLF (path capture must not swallow \\r)", () => {
    const crlfDiff = [
      "--- a/src/ok.ts",
      "+++ b/src/ok.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/.env",
      "+++ b/.env",
      "@@ -0,0 +1 @@",
      "+INTERNAL_SERVICE_TICKET=qq-771234",
    ].join("\r\n");
    const sanitized = applyModelContentPolicy(makeContext({ diff: crlfDiff }));
    expect(sanitized.diff).not.toContain("INTERNAL_SERVICE_TICKET=qq-771234");
    expect(sanitized.diff).toContain("+b");
  });

  it("deletion sections identify by the old-side path without inventing a previousPath", () => {
    // Self-review regression (S1): `+++ /dev/null` marks a deletion; the
    // resolved path is the old side and previousPath must stay absent so the
    // section is dropped exactly once, by its one real path.
    const sanitized = applyModelContentPolicy(makeContext({
      diff: [
        "--- a/.env.production",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-zz-nonregex-secret-42",
      ].join("\n"),
    }));
    expect(sanitized.diff).not.toContain("zz-nonregex-secret-42");
    expect(sanitized.diff).not.toContain("--- a/.env.production");
  });
});

/**
 * Armored PRIVATE KEY coverage (task-9): the legacy whitelist (`RSA |EC |
 * OPENSSH |DSA `) missed the modern PKCS#8 `ENCRYPTED PRIVATE KEY` and the PGP
 * `PGP PRIVATE KEY BLOCK` armor, so committed key material reached every
 * model-visible surface. These fixtures use synthetic alphanumeric bodies.
 */
const ARMORED_FORMS = [
  {
    name: "ENCRYPTED PRIVATE KEY",
    header: "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    footer: "-----END ENCRYPTED PRIVATE KEY-----",
    tag: "POLICYENCRYPTED",
  },
  {
    name: "PGP PRIVATE KEY BLOCK",
    header: "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    footer: "-----END PGP PRIVATE KEY BLOCK-----",
    tag: "POLICYPGP",
  },
] as const;

function armoredKeyFile(form: (typeof ARMORED_FORMS)[number]): string {
  return [
    "line-before",
    form.header,
    `MIIEowIBAAKCAQEA${form.tag}BODY0001`,
    `ZmFrZWJhc2U2NA${form.tag}BODY0002`,
    form.footer,
    "line-after",
  ].join("\n");
}

describe("applyModelContentPolicy — armored PRIVATE KEY forms (task-9)", () => {
  for (const form of ARMORED_FORMS) {
    it(`keeps ${form.name} out of fileContents, diff and changedFiles[].patch with lines preserved`, () => {
      const raw = armoredKeyFile(form);
      const rawPatch = raw.split("\n").map((line) => `+${line}`).join("\n");
      const rawDiff = ["--- a/src/config.ts", "+++ b/src/config.ts", "@@ -0,0 +1,6 @@", rawPatch].join("\n");
      const context = makeContext({
        fileContents: { "src/config.ts": raw },
        diff: rawDiff,
        changedFiles: [
          {
            path: "src/config.ts",
            status: "added",
            additions: 6,
            deletions: 0,
            changes: 6,
            patch: rawPatch,
          },
        ],
      });

      const sanitized = applyModelContentPolicy(context);
      const surfaces: Array<[string, string | undefined, string]> = [
        ["fileContents", sanitized.fileContents["src/config.ts"], raw],
        ["diff", sanitized.diff, rawDiff],
        ["changedFiles[].patch", sanitized.changedFiles[0]!.patch, rawPatch],
      ];

      for (const [label, value, original] of surfaces) {
        expect(value, label).toBeDefined();
        expect(value!, label).not.toContain(form.header);
        expect(value!, label).not.toContain(form.footer);
        expect(value!, label).not.toContain(`${form.tag}BODY0001`);
        expect(value!, label).not.toContain(`${form.tag}BODY0002`);
        expect(value!, label).not.toContain("-----BEGIN");
        // Line anchors survive so grounding ranges stay valid.
        expect(value!.split("\n").length, label).toBe(original.split("\n").length);
      }
      // Surrounding code is untouched on the file-contents surface.
      expect(sanitized.fileContents["src/config.ts"]).toContain("line-before");
      expect(sanitized.fileContents["src/config.ts"]).toContain("line-after");
    });
  }

  it("is idempotent for armored key material", () => {
    const form = ARMORED_FORMS[0];
    const raw = armoredKeyFile(form);
    const once = applyModelContentPolicy(makeContext({ fileContents: { "src/config.ts": raw } }));
    const twice = applyModelContentPolicy(once);
    expect(twice.fileContents["src/config.ts"]).toBe(once.fileContents["src/config.ts"]);
    expect(once.fileContents["src/config.ts"]!.split("\n")).toHaveLength(6);
  });

  it("leaves PUBLIC KEY / CERTIFICATE armor untouched (not credential material)", () => {
    const publicKey = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQENBGFAKEPUBLICKEY0001\n-----END PGP PUBLIC KEY BLOCK-----";
    const certificate = "-----BEGIN CERTIFICATE-----\nMIICERTIFICATE0001\n-----END CERTIFICATE-----";
    expect(redactModelVisibleText(publicKey)).toBe(publicKey);
    expect(redactModelVisibleText(certificate)).toBe(certificate);
  });
});
