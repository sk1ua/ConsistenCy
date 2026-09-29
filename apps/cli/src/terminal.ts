/**
 * Minimal terminal primitives for the ConsistenCy CLI.
 *
 * Deliberately dependency-free: the CLI must run straight from `tsx` in a
 * checkout with nothing installed beyond the workspace itself. Colour is
 * opt-out via `--no-color`, `NO_COLOR`, or a non-TTY stdout, so piping the
 * human renderer into a file or another program never injects escape codes.
 */

export type Palette = {
  bold: (value: string) => string;
  dim: (value: string) => string;
  red: (value: string) => string;
  green: (value: string) => string;
  yellow: (value: string) => string;
  blue: (value: string) => string;
  magenta: (value: string) => string;
  cyan: (value: string) => string;
};

const identity = (value: string): string => value;

export const plainPalette: Palette = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  magenta: identity,
  cyan: identity
};

function wrap(open: number, close: number): (value: string) => string {
  return value => `\u001b[${open}m${value}\u001b[${close}m`;
}

export const ansiPalette: Palette = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39)
};

/**
 * An explicit `--no-color` wins over everything; `NO_COLOR` (any non-empty
 * value, per the de-facto standard) comes next; a non-TTY stdout is never
 * coloured even when the user did not ask for it.
 */
export function shouldUseColor(
  stream: { isTTY?: boolean } | undefined,
  environment: NodeJS.ProcessEnv,
  force?: boolean
): boolean {
  if (force === false) return false;
  if (environment.NO_COLOR !== undefined && environment.NO_COLOR !== "") return false;
  if (force === true) return true;
  return stream?.isTTY === true;
}

export function paletteFor(useColor: boolean): Palette {
  return useColor ? ansiPalette : plainPalette;
}

/**
 * `3 个文件` — a count plus its unit.
 *
 * The plural form defaults to the singular on purpose: every caller passes a
 * Chinese unit, and Chinese does not inflect nouns, so appending an English
 * `s` produced strings like `0 个文件s` and `6 个专项审查 agents`. Pass an
 * explicit `pluralForm` only for a unit that genuinely needs one.
 */
export function plural(count: number, singular: string, pluralForm = singular): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Byte size rendered for humans; used for progress and constraint lines. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** `1.2s`, `2m04s` — wall-clock durations for the run footer. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Left-pads every line so multi-line values (finding reasoning, error text)
 * align under a label without every caller re-implementing the indent.
 */
export function indent(value: string, prefix: string): string {
  return value
    .split(/\r?\n/)
    .map(line => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

/** Collapses internal whitespace so a value cannot break the line layout. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
