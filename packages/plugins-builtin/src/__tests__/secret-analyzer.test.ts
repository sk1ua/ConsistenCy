/**
 * SecretAnalyzer tests — AC-SECRET-1 … AC-SECRET-6 + AC-EVID-7 (redaction).
 *
 * Uses SYNTHETIC fake secrets only — never real credentials.
 */

import { describe, it, expect } from "vitest";
import {
  EvidenceStore,
  computeEvidenceFingerprint,
  type EvidenceInput,
} from "@consistency/kernel";
import {
  SECRET_ANALYZER_VERSION,
  SecretAnalyzer,
  TreeSitterService,
  redactSensitiveText,
  type AnalyzerDeps,
  type AnalyzerInput,
} from "../index.js";

const FAKE_GITHUB_TOKEN = `ghp_${"A".repeat(36)}`; // synthetic, invalid format for real use
const FAKE_AWS_KEY = `AKIA${"1".repeat(16)}`;
const FAKE_PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAsyntheticfakekeymaterial123456789",
  "morefakebase64materialABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function makeDeps(files: Record<string, string>): AnalyzerDeps {
  return {
    readFile: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`missing fixture file ${path}`);
      return { path, content };
    },
    treeSitter: new TreeSitterService(),
  };
}

function makeInput(files: Record<string, string>): AnalyzerInput {
  return {
    repository: "test/example",
    headSha: "abc123def456",
    files: Object.keys(files).sort(),
  };
}

const analyzer = new SecretAnalyzer();

describe("SecretAnalyzer — deterministic secret detection with redaction", () => {
  it("AC-SECRET-1: synthetic literal secrets are detected", async () => {
    const files = {
      "src/secrets.ts": [
        `const gh = "${FAKE_GITHUB_TOKEN}";`,
        `const aws = "${FAKE_AWS_KEY}";`,
        FAKE_PRIVATE_KEY,
      ].join("\n"),
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));

    expect(evidence.map((e) => e.ruleId)).toEqual([
      "secret.github-token",
      "secret.aws-access-key",
      "secret.private-key-header",
    ]);
    expect(evidence[0]!.location).toEqual({ path: "src/secrets.ts", startLine: 1, endLine: 1 });
    expect(evidence[2]!.location.startLine).toBe(3); // private key header line
  });

  it("AC-SECRET-2: environment-variable references are NOT leaked secrets", async () => {
    const files = {
      "src/refs.ts": [
        'const token = process.env.GITHUB_TOKEN;',
        'const key = os.environ["API_KEY"];',
        "const password = process.env.DB_PASSWORD ?? 'default';",
      ].join("\n"),
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    expect(evidence).toEqual([]);
  });

  it("AC-SECRET-3: placeholder/example values avoid obvious false positives", async () => {
    const files = {
      "src/docs.ts": [
        'const apiKey = "your_api_key_here";',
        'const password = "changeme1234567890";',
        'const secret = "xxxxxxxxxxxxxxxx";',
        'const example = "example_credential_value_123";',
      ].join("\n"),
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    expect(evidence).toEqual([]);
  });

  it("AC-SECRET-4: private-key fixture is detected WITHOUT storing the raw key", async () => {
    const files = { "key.pem": FAKE_PRIVATE_KEY };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));

    expect(evidence).toHaveLength(1);
    const serialized = JSON.stringify(evidence[0]);
    expect(serialized).not.toContain("MIIEowIBAAKCAQEA"); // key body never stored
    expect(serialized).not.toContain("morefakebase64material");
    // The body lines produce no additional evidence either.
  });

  it("AC-SECRET-5 / AC-EVID-7: redacted payload contains no complete secret", async () => {
    const files = {
      "src/redact.ts": [
        `const gh = "${FAKE_GITHUB_TOKEN}";`,
        `const password = "supersecretvalue123456789";`,
      ].join("\n"),
    };
    const inputs = await analyzer.analyze(makeInput(files), makeDeps(files));
    const store = new EvidenceStore();
    const records = inputs.map((input) => store.add(input));

    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
      expect(serialized).not.toContain("supersecretvalue123456789");
    }
    // Redaction markers are present; fingerprints give correlation without the secret.
    expect(JSON.stringify(records[0]!.payload)).toContain("[REDACTED]");
    expect((records[0]!.payload as { secretFingerprint: string }).secretFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC-SECRET-6: same snapshot analyzed twice yields a deterministic fingerprint sequence", async () => {
    const files = {
      "src/mixed.ts": [
        `const a = "${FAKE_GITHUB_TOKEN}";`,
        "const b = process.env.NOT_A_SECRET;",
        FAKE_PRIVATE_KEY,
      ].join("\n"),
    };
    const input = makeInput(files);
    const deps = makeDeps(files);

    const run1 = await analyzer.analyze(input, deps);
    const run2 = await analyzer.analyze(input, deps);

    expect(run1.map(computeEvidenceFingerprint)).toEqual(run2.map(computeEvidenceFingerprint));
    expect(run1).toHaveLength(2); // token + private key header
  });

  it("AC-SECRET-7: encrypted (PKCS#8) and PGP private key blocks get the same detection as legacy PEM", async () => {
    const blocks = [
      {
        header: "-----BEGIN PRIVATE KEY-----",
        footer: "-----END PRIVATE KEY-----",
        tag: "AAONEPLAIN",
      },
      {
        header: "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        footer: "-----END ENCRYPTED PRIVATE KEY-----",
        tag: "BBENCRYPTED",
      },
      {
        header: "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        footer: "-----END PGP PRIVATE KEY BLOCK-----",
        tag: "CCPGPBLOCK",
      },
    ];
    const lines: string[] = [];
    for (const block of blocks) {
      lines.push(
        block.header,
        `MIIEowIBAAKCAQEA${block.tag}BODY0001`,
        `ZmFrZWJhc2U2NA${block.tag}BODY0002`,
        block.footer,
        `# separator after ${block.tag}`,
      );
    }
    const files = { "keys/app.pem": lines.join("\n") };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));

    // Committed encrypted/PGP key armor is detected exactly like legacy PEM...
    expect(evidence).toHaveLength(3);
    expect(evidence.map((e) => e.ruleId)).toEqual([
      "secret.private-key-header",
      "secret.private-key-header",
      "secret.private-key-header",
    ]);
    expect(evidence.map((e) => e.location.startLine)).toEqual([1, 6, 11]);
    // ...with the same severity/confidence and secret type as the existing rule.
    expect(evidence.map((e) => e.confidence)).toEqual([0.95, 0.95, 0.95]);
    for (const item of evidence) {
      expect(item.payload).toMatchObject({
        kind: "secret",
        secretType: "private-key",
        ruleId: "secret.private-key-header",
      });
    }
    // No key body ever reaches the evidence payload.
    const serialized = JSON.stringify(evidence);
    for (const block of blocks) {
      expect(serialized).not.toContain(`${block.tag}BODY0001`);
      expect(serialized).not.toContain(`${block.tag}BODY0002`);
    }
  });

  it("AC-SECRET-8: redacting an armored key block leaves nothing for the detector to find", async () => {
    // Reverse guard: if redaction were weakened, this test fails because the
    // sanitized text would still trip the private-key rule.
    const form = {
      header: "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      footer: "-----END ENCRYPTED PRIVATE KEY-----",
      tag: "DDREVERSEGUARD",
    };
    const raw = [
      "line-before",
      form.header,
      `MIIEowIBAAKCAQEA${form.tag}BODY0001`,
      form.footer,
      "line-after",
    ].join("\n");
    const redacted = redactSensitiveText(raw);
    expect(redacted.split("\n")).toHaveLength(raw.split("\n").length);
    expect(redacted).not.toContain("-----BEGIN");
    expect(redacted).not.toContain(form.tag);

    const files = { "src/config.ts": redacted };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    expect(evidence).toEqual([]);
  });

  it("red-team: quotes, whitespace, and hardcoded assignment variants behave deterministically", async () => {
    const files = {
      "src/variants.ts": [
        "const a = 'hardcoded_password_value_12345';", // single quotes — but key name missing → not matched
        "password='anothersecretvalue12345';", // single quotes, assignment
        'token = "short";', // too short — ignored
        "client_secret = \"clientsecretvalue123456789\";", // double quotes
      ].join("\n"),
    };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    expect(evidence.map((e) => e.location.startLine)).toEqual([2, 4]);
    expect(evidence.every((e) => e.provenance.analyzer === "secret")).toBe(true);
    expect(evidence.every((e) => e.provenance.analyzerVersion === SECRET_ANALYZER_VERSION)).toBe(true);
    expect(SECRET_ANALYZER_VERSION).toBe("1.1.0");
  });

  it("red-team: a comment containing a literal credential is still reported (documented behavior)", async () => {
    const files = { "src/comment.ts": `// rotation backup: ${FAKE_GITHUB_TOKEN}\n` };
    const evidence = await analyzer.analyze(makeInput(files), makeDeps(files));
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence[0])).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it("red-team: fingerprint stability across separately-constructed inputs", () => {
    const make = (): EvidenceInput => ({
      source: "sast",
      ruleId: "secret.github-token",
      location: { path: "a.ts", startLine: 1, endLine: 1 },
      confidence: 0.95,
      payload: {
        kind: "secret",
        secretType: "github-token",
        ruleId: "secret.github-token",
        redactedExcerpt: "const x = [REDACTED]",
        secretFingerprint: "f".repeat(64),
      },
      provenance: {
        repository: "test/example",
        sha: "sha1",
        analyzer: "secret",
        analyzerVersion: "1.0.0",
      },
    });
    expect(computeEvidenceFingerprint(make())).toBe(computeEvidenceFingerprint(make()));
  });
});
