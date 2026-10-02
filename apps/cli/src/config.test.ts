import { describe, expect, it } from "vitest";
import { resolveMemoryEnabled } from "./config";

describe("CLI persisted memory resolution", () => {
  it("preserves memory by default", () => {
    expect(resolveMemoryEnabled({}, {})).toBe(true);
    expect(resolveMemoryEnabled({ noMemory: false }, {})).toBe(true);
  });

  it("always honors --no-memory, including when the environment says 0", () => {
    expect(resolveMemoryEnabled({ noMemory: true }, {})).toBe(false);
    expect(resolveMemoryEnabled({ noMemory: true }, { CONSISTENCY_NO_MEMORY: "0" })).toBe(false);
  });

  it("disables memory for CONSISTENCY_NO_MEMORY=1 without a CLI flag", () => {
    expect(resolveMemoryEnabled({}, { CONSISTENCY_NO_MEMORY: "1" })).toBe(false);
    expect(resolveMemoryEnabled({ noMemory: false }, { CONSISTENCY_NO_MEMORY: "1" })).toBe(false);
  });

  it.each(["0", "", "true", "false", "01"])("keeps memory enabled for env value %j", value => {
    expect(resolveMemoryEnabled({}, { CONSISTENCY_NO_MEMORY: value })).toBe(true);
  });
});
