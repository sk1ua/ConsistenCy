import { describe, expect, it } from "vitest";
import { matchesCronExpression, nextCronOccurrence, parseCronExpression } from "./cron";

describe("cron5 evaluator", () => {
  it("supports numeric lists, ranges, and steps", () => {
    const parsed = parseCronExpression("*/15 9-17 * * 1-5");
    expect([...parsed.minute.values]).toEqual([0, 15, 30, 45]);
    expect(parsed.hour.values.has(12)).toBe(true);
    expect(parsed.dayOfWeek.values.has(6)).toBe(false);
    expect(matchesCronExpression(
      "*/15 9-17 * * 1-5",
      "UTC",
      new Date("2026-08-14T09:30:00.000Z")
    )).toBe(true);
  });

  it("computes the first future occurrence in the configured timezone", () => {
    expect(nextCronOccurrence(
      "0 9 * * *",
      "Asia/Hong_Kong",
      new Date("2026-08-14T00:30:25.000Z")
    ).toISOString()).toBe("2026-08-14T01:00:00.000Z");
    expect(nextCronOccurrence(
      "0 9 * * *",
      "Asia/Hong_Kong",
      new Date("2026-08-14T01:00:00.000Z")
    ).toISOString()).toBe("2026-08-15T01:00:00.000Z");
  });

  it("uses standard OR semantics when day-of-month and day-of-week are both restricted", () => {
    // 2026-08-14 is Friday, so it matches even though it is not day one.
    expect(matchesCronExpression(
      "0 0 1 * 5",
      "UTC",
      new Date("2026-08-14T00:00:00.000Z")
    )).toBe(true);
    expect(nextCronOccurrence(
      "0 0 1 * 5",
      "UTC",
      new Date("2026-08-14T00:00:00.000Z")
    ).toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("treats */1 as an unrestricted day field", () => {
    expect(matchesCronExpression(
      "0 9 */1 * 1",
      "UTC",
      new Date("2026-08-18T09:00:00.000Z")
    )).toBe(false);
  });
});
