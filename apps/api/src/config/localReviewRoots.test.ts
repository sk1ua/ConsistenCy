import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";
import { findProjectRoot } from "./settings";

const baseEnv = {
  NODE_ENV: "development",
  CONSISTENCY_PUBLIC_PR_ANALYSIS_ENABLED: "false",
  CONSISTENCY_NOTEBOOK_ENABLED: "false"
} as const;

describe("CONSISTENCY_LOCAL_REVIEW_ROOTS", () => {
  it("defaults to the project's parent directory", () => {
    const config = loadEnv({ ...baseEnv });
    expect(config.localReviewRoots).toEqual([dirname(findProjectRoot())]);
  });

  it("parses an explicit comma-separated list into absolute paths", () => {
    const config = loadEnv({
      ...baseEnv,
      CONSISTENCY_LOCAL_REVIEW_ROOTS: " D:/work/alpha , D:/work/beta "
    });
    expect(config.localReviewRoots).toEqual([resolve("D:/work/alpha"), resolve("D:/work/beta")]);
  });

  it("ignores blank entries rather than silently allowing an empty root", () => {
    const config = loadEnv({
      ...baseEnv,
      CONSISTENCY_LOCAL_REVIEW_ROOTS: "D:/work/alpha,,  ,"
    });
    expect(config.localReviewRoots).toEqual([resolve("D:/work/alpha")]);
  });

  it("flags when the broad default is in force so startup can warn", () => {
    expect(loadEnv({ ...baseEnv }).localReviewRootsAreDefaulted).toBe(true);
    expect(loadEnv({
      ...baseEnv,
      CONSISTENCY_LOCAL_REVIEW_ROOTS: "D:/work/alpha"
    }).localReviewRootsAreDefaulted).toBe(false);
  });

  it("accepts an explicit list in production", () => {
    const config = loadEnv({
      ...baseEnv,
      NODE_ENV: "production",
      CONSISTENCY_API_TOKEN: "token",
      CONSISTENCY_ALLOWED_ORIGINS: "https://dashboard.example.com",
      CONSISTENCY_LOCAL_REVIEW_ROOTS: "/srv/checkouts"
    });
    expect(config.localReviewRoots).toEqual([resolve("/srv/checkouts")]);
  });
});
