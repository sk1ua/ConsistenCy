import { describe, expect, it } from "vitest";
import { buildHealthPayload } from "./health";

describe("buildHealthPayload", () => {
  it("describes the TS shell around the Python engine", () => {
    expect(buildHealthPayload()).toEqual({
      ok: true,
      service: "consistency-api",
      engine: "python",
      schemaVersion: "0.1.0"
    });
  });
});
