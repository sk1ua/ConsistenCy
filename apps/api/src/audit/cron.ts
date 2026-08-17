import { cronScheduleSpecSchema } from "@consistency/schema";

type ParsedCronField = {
  values: ReadonlySet<number>;
  wildcard: boolean;
};

export type ParsedCronExpression = {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
};

type ZonedMinute = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

const WEEKDAY_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function expandField(raw: string, minimum: number, maximum: number, normalize?: (value: number) => number): ParsedCronField {
  const values = new Set<number>();
  for (const segment of raw.split(",")) {
    const [rawBase, rawStep] = segment.split("/");
    const base = rawBase!;
    const step = rawStep === undefined ? 1 : Number(rawStep);
    let start: number;
    let end: number;
    if (base === "*") {
      start = minimum;
      end = maximum;
    } else if (base.includes("-")) {
      [start, end] = base.split("-").map(Number) as [number, number];
    } else {
      start = Number(base);
      end = rawStep === undefined ? start : maximum;
    }
    for (let value = start; value <= end; value += step) values.add(normalize?.(value) ?? value);
  }
  return { values, wildcard: raw === "*" || raw === "*/1" };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  // Reuse the public contract so the evaluator cannot silently accept syntax
  // that repository DTO validation rejects.
  const parsed = cronScheduleSpecSchema.parse({ cron: expression, timezone: "UTC" });
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed.cron.split(/\s+/);
  return {
    minute: expandField(minute!, 0, 59),
    hour: expandField(hour!, 0, 23),
    dayOfMonth: expandField(dayOfMonth!, 1, 31),
    month: expandField(month!, 1, 12),
    dayOfWeek: expandField(dayOfWeek!, 0, 7, value => value === 7 ? 0 : value)
  };
}

function formatter(timezone: string): Intl.DateTimeFormat {
  // Validates the zone and forces stable numeric Gregorian parts on Node 22.
  cronScheduleSpecSchema.parse({ cron: "* * * * *", timezone });
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
}

function zonedMinute(date: Date, dateFormatter: Intl.DateTimeFormat): ZonedMinute {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
  const weekday = WEEKDAY_NUMBER[parts.weekday ?? ""];
  if (weekday === undefined) throw new Error("Unable to evaluate cron weekday in configured timezone");
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday
  };
}

function dateMatches(cron: ParsedCronExpression, parts: ZonedMinute): boolean {
  if (!cron.month.values.has(parts.month)) return false;
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (cron.dayOfWeek.wildcard) return dayOfMonthMatches;
  // Standard five-field cron treats restricted day-of-month/day-of-week as OR.
  return dayOfMonthMatches || dayOfWeekMatches;
}

function cronMatches(cron: ParsedCronExpression, parts: ZonedMinute): boolean {
  return dateMatches(cron, parts)
    && cron.hour.values.has(parts.hour)
    && cron.minute.values.has(parts.minute);
}

export function matchesCronExpression(expression: string, timezone: string, date: Date): boolean {
  return cronMatches(parseCronExpression(expression), zonedMinute(date, formatter(timezone)));
}

function minutesUntilNextAllowedMinute(field: ParsedCronField, currentMinute: number): number {
  const ordered = [...field.values].sort((left, right) => left - right);
  const later = ordered.find(value => value > currentMinute);
  return later === undefined ? 60 - currentMinute + ordered[0]! : later - currentMinute;
}

/** Returns the first matching minute strictly after `after`. */
export function nextCronOccurrence(expression: string, timezone: string, after: Date): Date {
  if (!Number.isFinite(after.getTime())) throw new TypeError("after must be a valid Date");
  const cron = parseCronExpression(expression);
  const dateFormatter = formatter(timezone);
  let cursor = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = cursor.getTime() + 5 * 366 * 24 * 60 * 60_000;

  while (cursor.getTime() <= limit) {
    const parts = zonedMinute(cursor, dateFormatter);
    if (cronMatches(cron, parts)) return cursor;

    let advanceMinutes: number;
    if (!dateMatches(cron, parts)) {
      // No remaining minute on this local date can match. Approach the next
      // local midnight in bounded steps so DST transitions are re-evaluated.
      const untilNominalMidnight = 24 * 60 - (parts.hour * 60 + parts.minute);
      advanceMinutes = Math.max(1, Math.min(15, untilNominalMidnight));
    } else {
      advanceMinutes = minutesUntilNextAllowedMinute(cron.minute, parts.minute);
    }
    cursor = new Date(cursor.getTime() + advanceMinutes * 60_000);
  }
  throw new RangeError("Cron expression has no occurrence within the supported five-year horizon");
}
