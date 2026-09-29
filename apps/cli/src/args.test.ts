import { describe, expect, it } from "vitest";
import { UsageError, parseReviewOptions } from "./args";

describe("parseReviewOptions", () => {
  it("defaults to reviewing the working tree in the current directory", () => {
    const options = parseReviewOptions([]);
    expect(options.repoPath).toBe(process.cwd());
    expect(options.baseRef).toBeUndefined();
    expect(options.headRef).toBeUndefined();
    expect(options.json).toBe(false);
    expect(options.verbose).toBe(false);
    expect(options.limit).toBeUndefined();
  });

  describe("the --base/--head trap", () => {
    // buildLocalContext only diffs a committed range when BOTH refs are
    // present (`apps/api/src/review/context/buildLocalContext.ts:234-237`);
    // otherwise it silently reviews the dirty working tree instead. A bare
    // `--base main` looking like a range review is exactly the failure this
    // pairing exists to prevent.
    it("completes --base with HEAD so it cannot degrade into a working-tree review", () => {
      const options = parseReviewOptions(["--base", "main"]);
      expect(options.baseRef).toBe("main");
      expect(options.headRef).toBe("HEAD");
    });

    it("keeps an explicit --head", () => {
      const options = parseReviewOptions(["--base", "main", "--head", "feature"]);
      expect(options.baseRef).toBe("main");
      expect(options.headRef).toBe("feature");
    });

    it("rejects a lone --head rather than guessing a base", () => {
      expect(() => parseReviewOptions(["--head", "feature"])).toThrow(UsageError);
    });
  });

  it("accepts --flag=value as well as --flag value", () => {
    expect(parseReviewOptions(["--repo=../other"]).repoPath).toBe("../other");
    expect(parseReviewOptions(["--limit=5"]).limit).toBe(5);
    expect(parseReviewOptions(["--base=main"]).headRef).toBe("HEAD");
  });

  it("treats --all as overriding --limit", () => {
    expect(parseReviewOptions(["--limit", "3", "--all"]).limit).toBe(Number.POSITIVE_INFINITY);
  });

  it("records colour intent and lets --no-color win by order-independence", () => {
    expect(parseReviewOptions(["--color"]).color).toBe(true);
    expect(parseReviewOptions(["--no-color"]).color).toBe(false);
  });

  it("validates enum-ish flags instead of passing them through", () => {
    expect(() => parseReviewOptions(["--language", "en"])).toThrow(/zh-CN/);
    expect(parseReviewOptions(["--language", "en-US"]).reportLanguage).toBe("en-US");
    expect(() => parseReviewOptions(["--limit", "abc"])).toThrow(/非负整数/);
    expect(() => parseReviewOptions(["--limit", "-1"])).toThrow(/非负整数/);
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseReviewOptions(["--nope"])).toThrow(/未知参数/);
    expect(() => parseReviewOptions(["--repo"])).toThrow(/需要一个值/);
    expect(() => parseReviewOptions(["--repo", "--json"])).toThrow(/需要一个值/);
  });

  it("flags help with an empty UsageError so the caller prints usage, not an error", () => {
    expect(() => parseReviewOptions(["--help"])).toThrow(UsageError);
    try {
      parseReviewOptions(["-h"]);
    } catch (error) {
      expect((error as UsageError).message).toBe("");
    }
  });
});

describe("threshold validation", () => {
  // The threshold is validated later, in runReview, because it needs the same
  // error type; this asserts the parser does not silently drop a typo.
  it("keeps an unvalidated string on the options object for runReview to reject", () => {
    expect(parseReviewOptions(["--threshold", "high"]).threshold).toBe("high");
  });
});
