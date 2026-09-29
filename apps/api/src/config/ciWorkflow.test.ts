import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CI Workflow Static Assertion Test", () => {
  it("ci.yml contains zero references to legacy V1 CLI publishing steps", () => {
    const ciPath = resolve(__dirname, "../../../../.github/workflows/ci.yml");
    const content = readFileSync(ciPath, "utf8");

    expect(content).not.toContain("backend/cli.py");
    expect(content).not.toContain("review_suggestions");
    expect(content).not.toContain("issues.createComment");
  });
});
