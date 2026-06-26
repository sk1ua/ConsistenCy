import { describe, expect, it } from "vitest";
import { redactSensitiveText, sanitizePublicError } from "./redact";

describe("security redaction", () => {
  it("removes credentials before content reaches logs or prompts", () => {
    const input = "token=github_pat_abcdefghijklmnopqrstuvwxyz123456 and Authorization: Bearer secret.value";
    const output = redactSensitiveText(input);
    expect(output).not.toContain("github_pat_");
    expect(output).not.toContain("secret.value");
    expect(output).toContain("[REDACTED]");
  });

  it("removes local absolute paths from public errors", () => {
    expect(sanitizePublicError("Failed at C:\\Users\\demo\\project\\secret.txt token=abcdefghijk"))
      .toBe("Failed at  [PATH_REDACTED] token=[REDACTED]");
  });
});
