/**
 * Analyzer excerpt redaction tests (task-9 / H25 line anchors).
 *
 * The leaked material is SYNTHETIC: bodies are fixed fake base64-ish markers,
 * never a real key. Every fixture uses a distinguishable ALPHANUMERIC tag so
 * "did the body survive?" is an exact substring check.
 */

import { describe, it, expect } from "vitest";
import { redactSensitiveText } from "../index.js";
import { redactPrivateKeyBlocks } from "../index.js";

type KeyForm = {
  readonly name: string;
  readonly header: string;
  readonly footer: string;
  /** Alphanumeric tag embedded in the fake body lines. */
  readonly tag: string;
};

/** Six armored PRIVATE KEY forms; the first five are the legacy whitelist. */
const KEY_FORMS: readonly KeyForm[] = [
  { name: "PRIVATE KEY", header: "-----BEGIN PRIVATE KEY-----", footer: "-----END PRIVATE KEY-----", tag: "AAONE" },
  { name: "RSA PRIVATE KEY", header: "-----BEGIN RSA PRIVATE KEY-----", footer: "-----END RSA PRIVATE KEY-----", tag: "BBRSA" },
  { name: "EC PRIVATE KEY", header: "-----BEGIN EC PRIVATE KEY-----", footer: "-----END EC PRIVATE KEY-----", tag: "CCEC" },
  { name: "OPENSSH PRIVATE KEY", header: "-----BEGIN OPENSSH PRIVATE KEY-----", footer: "-----END OPENSSH PRIVATE KEY-----", tag: "DDOPENSSH" },
  { name: "DSA PRIVATE KEY", header: "-----BEGIN DSA PRIVATE KEY-----", footer: "-----END DSA PRIVATE KEY-----", tag: "EEDSA" },
  { name: "ENCRYPTED PRIVATE KEY", header: "-----BEGIN ENCRYPTED PRIVATE KEY-----", footer: "-----END ENCRYPTED PRIVATE KEY-----", tag: "FFENCRYPTED" },
  { name: "PGP PRIVATE KEY BLOCK", header: "-----BEGIN PGP PRIVATE KEY BLOCK-----", footer: "-----END PGP PRIVATE KEY BLOCK-----", tag: "GGPGP" },
];

function bodyLines(tag: string): string[] {
  return [`MIIEowIBAAKCAQEA${tag}BODY0001`, `ZmFrZWJhc2U2NA${tag}BODY0002`];
}

function textWithBlock(form: KeyForm, eol = "\n"): string {
  return ["line-before", form.header, ...bodyLines(form.tag), form.footer, "line-after"].join(eol);
}

function expectNoKeyResidue(output: string, form: KeyForm, original: string): void {
  for (const body of bodyLines(form.tag)) expect(output).not.toContain(body);
  expect(output).not.toContain(form.header);
  expect(output).not.toContain(form.footer);
  // No fragment of the armor survives (BEGIN/END lines or their algorithm name).
  expect(output).not.toContain("-----BEGIN");
  expect(output).not.toContain("-----END");
  expect(output).not.toContain("PRIVATE KEY-----");
  expect(output).toContain("[REDACTED");
  // Anchors around the block are untouched.
  expect(output).toContain("line-before");
  expect(output).toContain("line-after");
  expect(output).not.toBe(original);
}

describe("redactSensitiveText — armored private key blocks", () => {
  for (const form of KEY_FORMS) {
    it(`REDACT-KEY-${form.name}: redacts the block, preserves line count, and is idempotent`, () => {
      const original = textWithBlock(form);
      const output = redactSensitiveText(original);

      // 1. Line count is preserved (\n split) so evidence line anchors survive.
      expect(output.split("\n")).toHaveLength(original.split("\n").length);
      // 2. No armor/body residue.
      expectNoKeyResidue(output, form, original);
      // 3. Idempotent: a second pass changes neither content nor line count.
      const twice = redactSensitiveText(output);
      expect(twice).toBe(output);
      expect(twice.split("\n")).toHaveLength(output.split("\n").length);
    });
  }

  it("REDACT-KEY-truncated: a BEGIN line with no END line is still removed", () => {
    const original = [
      "const key = '",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "AAAAENCRYPTEDBODY0001",
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain("ENCRYPTEDBODY0001");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-one-line: a single-line PEM (BEGIN+body+END) stays one line", () => {
    const original = [
      "before",
      `key=-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEASINGLE0001-----END RSA PRIVATE KEY-----;`,
      "after",
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(3);
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain("SINGLE0001");
    expect(output).toContain("before");
    expect(output).toContain("after");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-lazy: a lone BEGIN line does not swallow unrelated text before a later block", () => {
    const form = KEY_FORMS[6]!; // PGP
    const original = [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "IMPORTANT-NOTE-MUST-SURVIVE",
      form.header,
      ...bodyLines(form.tag),
      form.footer,
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).toContain("IMPORTANT-NOTE-MUST-SURVIVE");
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain(form.tag);
  });

  it("REDACT-KEY-multiple: two blocks in one text are both redacted with lines preserved", () => {
    const rsa = KEY_FORMS[1]!;
    const pgp = KEY_FORMS[6]!;
    const original = [textWithBlock(rsa), "middle-marker", textWithBlock(pgp)].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).toContain("middle-marker");
    expect(output).not.toContain(rsa.tag);
    expect(output).not.toContain(pgp.tag);
    expect(output).not.toContain("-----BEGIN");
  });

  it("REDACT-KEY-crlf: CRLF text keeps its line count and line endings", () => {
    const form = KEY_FORMS[5]!; // ENCRYPTED
    const original = textWithBlock(form, "\r\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).toContain("\r\n");
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain(form.tag);
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-no-trailing-newline: a document without a final newline keeps its shape", () => {
    const form = KEY_FORMS[5]!;
    const original = textWithBlock(form); // no trailing "\n"
    const output = redactSensitiveText(original);
    expect(output.endsWith("\n")).toBe(false);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).not.toContain("-----BEGIN");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-truncated-body: an unterminated header blanks its armored body lines and stops at ordinary code", () => {
    // Size limits and diff-hunk boundaries can cut a key block before its END
    // line; the body that follows the header is still key material.
    const original = [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "MIIEowIBAAKCAQEATRUNCATEDBODY0001",
      "+ZmFrZWJhc2U2NEFUUlVOQ0FURURCT0RZMQ",
      "const ordinary = 1;",
      "after-code",
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain("TRUNCATEDBODY");
    // Guardrail: an unrelated line right after a stray header is NOT swallowed.
    expect(output).toContain("const ordinary = 1;");
    expect(output).toContain("after-code");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-truncated-pgp: armor headers before a truncated PGP body are redacted too", () => {
    // PGP armor puts `Version:`-style headers between BEGIN and the base64
    // body; a block cut before END must not stop scanning at those headers.
    const original = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "Version: GnuPG v2",
      "",
      "lQOYBGFAKEPGPSECRETBODY0001AAAAAAAAAAAAAAAAAAAAAA",
      "const code = 1;",
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain("GPGPSECRETBODY");
    expect(output).not.toContain("Version: GnuPG");
    expect(output).toContain("const code = 1;");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-partial-line: a body-shaped line with a suffix is left intact", () => {
    // Only complete armored body lines are consumed; a long identifier that
    // merely starts base64-ish must not be edited mid-line.
    const original = [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAPARTIALLINE0001;",
      "tail",
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).not.toContain("-----BEGIN");
    expect(output).toContain("MIIEowIBAAKCAQEAPARTIALLINE0001;");
    expect(output).toContain("tail");
  });

  it("REDACT-KEY-truncated-crlf: a truncated CRLF block keeps its line count and line endings", () => {
    const original = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "MIIEowIBAAKCAQEACRLFTRUNCATED0001",
      "tail",
    ].join("\r\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).toContain("\r\n");
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain("CRLFTRUNCATED0001");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-mismatched: a BEGIN does not pair with a differently-labelled END", () => {
    // The END label must match the BEGIN label, otherwise a stray header would
    // consume everything up to an unrelated block's END marker.
    const original = [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "UNRELATED-LINE-MUST-SURVIVE",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAMISMATCHBODY0001",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).toContain("UNRELATED-LINE-MUST-SURVIVE");
    expect(output).not.toContain("MISMATCHBODY0001");
    expect(output).not.toContain("-----BEGIN");
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("REDACT-KEY-public: PUBLIC KEY / CERTIFICATE armor is not treated as a secret", () => {
    // Explicit decision: public keys and certificates are not credential
    // material, so the excerpt sanitizer must leave them intact.
    const publicKey = ["-----BEGIN PGP PUBLIC KEY BLOCK-----", "mQENBGFAKEPUBLICKEY0001", "-----END PGP PUBLIC KEY BLOCK-----"].join("\n");
    const certificate = ["-----BEGIN CERTIFICATE-----", "MIICERTIFICATE0001", "-----END CERTIFICATE-----"].join("\n");
    expect(redactSensitiveText(publicKey)).toBe(publicKey);
    expect(redactSensitiveText(certificate)).toBe(certificate);
  });

  it("REDACT-KEY-existing-patterns: GitHub tokens and AWS key ids stay masked", () => {
    const github = `ghp_${"A".repeat(36)}`;
    const aws = `AKIA${"1".repeat(16)}`;
    const output = redactSensitiveText(`token="${github}"\naws="${aws}"\n`);
    expect(output).not.toContain(github);
    expect(output).not.toContain(aws);
    expect(output.split("\n")).toHaveLength(3);
    expect(redactSensitiveText(output)).toBe(output);
  });
});

describe("redactPrivateKeyBlocks — shared line-preserving helper", () => {
  it("exposes the same behavior as the excerpt sanitizer for key blocks", () => {
    const form = KEY_FORMS[5]!;
    const original = textWithBlock(form);
    const output = redactPrivateKeyBlocks(original);
    expect(output.split("\n")).toHaveLength(original.split("\n").length);
    expect(output).not.toContain("-----BEGIN");
    expect(output).not.toContain(form.tag);
    expect(redactPrivateKeyBlocks(output)).toBe(output);
    expect(redactSensitiveText(original)).toBe(output);
  });

  it("keeps the first line's position as a readable marker and blanks the rest", () => {
    const form = KEY_FORMS[1]!;
    const output = redactPrivateKeyBlocks(textWithBlock(form)).split("\n");
    expect(output[0]).toBe("line-before");
    expect(output[1]).toContain("[REDACTED");
    expect(output[2]).toBe("[REDACTED]");
    expect(output[3]).toBe("[REDACTED]");
    expect(output[4]).toBe("[REDACTED]");
    expect(output[5]).toBe("line-after");
  });
});
