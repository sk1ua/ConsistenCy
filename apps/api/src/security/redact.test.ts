import { describe, expect, it } from "vitest";
import { containsSensitiveData, redactSensitiveText, sanitizeExecutionError, sanitizePublicError, sanitizePublicValue } from "./redact";

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

  it("sanitizes execution failures as one-line bounded public text", () => {
    const output = sanitizeExecutionError(
      "workflow failed at C:\\secret\\repo and /home/user/repo\nAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890\nstack line"
    );
    expect(output).not.toContain("C:\\secret");
    expect(output).not.toContain("/home/user/repo");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("Authorization: Bearer");
    expect(output).not.toContain("\\n");
    expect(output).toContain("workflow failed");
  });

  it("sanitizes nested structured values without flattening their shape", () => {
    const value = sanitizePublicValue({ nested: [{ token: "x", message: "Failed at C:\\repo (copy)\\file.ts because denied" }], count: 2, missing: undefined }) as { nested: Array<Record<string, unknown>>; count: number; missing: undefined };
    expect(value.nested[0]?.token).toBe("[REDACTED]");
    expect(String(value.nested[0]?.message)).not.toContain("C:\\repo");
    expect(value.count).toBe(2);
    expect(value.missing).toBeUndefined();
  });

  it("redacts quoted and space-containing paths plus credential variants", () => {
    const output = sanitizePublicError(
      'failed at "C:\\Users\\Alice Smith\\repo (copy)\\file.ts" \\\\server\\share\\My Repo (copy)\\file.ts /home/alice/My Repo/file.ts token=ghp_abcdefghijklmnopqrstuvwxyz1234567890 Bearer github_pat_abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(output).not.toContain("Alice Smith");
    expect(output).not.toContain("\\\\server\\share");
    expect(output).not.toContain("/home/alice");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("github_pat_");
  });

  it("distinguishes shared references from true cycles and protects object keys", () => {
    const shared = { message: "ok" };
    const value = { first: shared, second: shared, __proto__: { polluted: true }, constructor: "bad" };
    const output = sanitizePublicValue(value) as Record<string, any>;
    expect(output.first).toEqual(output.second);
    expect(output.first).not.toBe("[CIRCULAR]");
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect((sanitizePublicValue(cycle) as any).self).toBe("[CIRCULAR]");
  });

  it("uses safe representations for special values and bounds strings", () => {
    const output = sanitizePublicValue({ date: new Date("2026-01-01T00:00:00Z"), error: new Error("boom"), fn() {}, symbol: Symbol("secret"), big: 1n, text: "x".repeat(5000) }) as any;
    expect(output.date).toBe("2026-01-01T00:00:00.000Z");
    expect(output.error).toEqual({ name: "Error", message: "boom" });
    expect(output.error.stack).toBeUndefined();
    expect(output.fn).toBe("[FUNCTION]");
    expect(output.symbol).toBe("[SYMBOL]");
    expect(output.big).toBe("[BIGINT]");
    expect(output.text.length).toBeLessThanOrEqual(2000);
  });

  it("removes complete raw and encoded URL userinfo while preserving host/path", () => {
    const values = [
      "https://user:p@ss@example.com/a",
      "https://user:p%40ss@[2001:db8::1]:8443/a?x=1#frag",
      "https://example.com/a",
    ];
    const output = values.map(sanitizePublicError);
    expect(output[0]).toBe("https://example.com/a");
    expect(output[0]).not.toContain("ss@example.com");
    expect(output[1]).toBe("https://[2001:db8::1]:8443/a?x=1#frag");
    expect(output[2]).toBe(values[2]);
  });

  it("redacts bounded absolute path forms and keeps sentence suffixes", () => {
    const output = sanitizePublicError(
      "path=/repo/src,bar/baz.ts;bar\\\\baz.ts at (C:\\\\Users\\\\alice\\\\secret.ts), permission denied file:///home/alice/private.ts; permission denied \\\\\\server\\\\share\\\\secret.ts"
    );
    expect(output).not.toContain("/repo");
    expect(output).not.toContain("bar/baz.ts");
    expect(output).not.toContain("bar\\\\baz.ts");
    expect(output).not.toContain("C:\\\\Users");
    expect(output).not.toContain("/home/alice");
    expect(output).not.toContain("\\\\server\\\\share");
    expect(output).toContain("permission denied");
  });

  it("matches sensitive tokens exactly and covers local roots without harming URLs or relative paths", () => {
    const output = sanitizePublicValue({ secretary: "keep", apiKey: "hide", refresh_token: "hide", path: "/data/a /private/b /custom-root/c /root/d /etc/e /usr/f /bin/g /sbin/h /mnt/i /app/j", relative: "src/foo.ts", url: "https://example.test/a", authUrl: "https://user:password@example.test/a", win: "C:\\Users\\Alice Smith\\repo (copy)\\x.ts because denied" }) as any;
    expect(output.secretary).toBe("keep");
    expect(output.apiKey).toBe("[REDACTED]");
    expect(output.refresh_token).toBe("[REDACTED]");
    expect(output.path).not.toContain("/root/");
    expect(output.path).not.toContain("/etc/");
    expect(output.relative).toBe("src/foo.ts");
    expect(output.url).toBe("https://example.test/a");
    expect(output.authUrl).toBe("https://example.test/a");
    expect(output.win).not.toContain("Alice Smith");
  });

  it("redacts single-segment Unix roots in diagnostic values", () => {
    const output = sanitizePublicValue({ one: "/etc", two: "/tmp", three: "/custom" }) as any;
    expect(output.one).toBe("[PATH_REDACTED]");
    expect(output.two).toBe("[PATH_REDACTED]");
    expect(output.three).toBe("[PATH_REDACTED]");
    expect(containsSensitiveData({ one: "/etc", two: "/tmp", three: "/custom" })).toBe(true);
  });

  it("does not consume an ordinary sentence after a path", () => {
    expect(sanitizePublicError("Error at /foo/bar.ts. Next step"))
      .toBe("Error at  [PATH_REDACTED]. Next step");
  });
});
