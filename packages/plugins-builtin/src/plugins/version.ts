/**
 * H22 — minimal semver range evaluation for plugin manifests.
 *
 * Deliberately self-contained: compatibility must be decided BEFORE any plugin
 * dependency is loaded, so this module pulls in no third-party range parser and
 * no code from the plugin it is about to admit.
 */

export type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value: string): Semver | undefined {
  const match = SEMVER.exec(value.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compare(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function satisfiesComparator(version: Semver, comparator: string): boolean {
  const caret = /^\^(.+)$/.exec(comparator);
  if (caret !== null) {
    const base = parseSemver(caret[1]!);
    if (!base) return false;
    const upper: Semver = base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0 }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: base.patch + 1 };
    return compare(version, base) >= 0 && compare(version, upper) < 0;
  }

  const tilde = /^~(.+)$/.exec(comparator);
  if (tilde !== null) {
    const base = parseSemver(tilde[1]!);
    if (!base) return false;
    const upper: Semver = { major: base.major, minor: base.minor + 1, patch: 0 };
    return compare(version, base) >= 0 && compare(version, upper) < 0;
  }

  const bound = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
  if (bound === null) return false;
  const base = parseSemver(bound[2]!);
  if (!base) return false;
  const order = compare(version, base);
  switch (bound[1]) {
    case ">=": return order >= 0;
    case "<=": return order <= 0;
    case ">": return order > 0;
    case "<": return order < 0;
    // A bare version means "exactly", matching how operators read a manifest.
    default: return order === 0;
  }
}

/** True when `version` lies inside any `||`-separated, space-joined range. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") return true;
  return trimmed
    .split("||")
    .some(alternative =>
      alternative
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every(comparator => satisfiesComparator(parsed, comparator))
    );
}

/** True when the range itself is syntactically usable (fail closed otherwise). */
export function isUsableRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") return true;
  return trimmed.split("||").every(alternative => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every(comparator => {
      const caret = /^\^(.+)$/.exec(comparator);
      const tilde = /^~(.+)$/.exec(comparator);
      const bound = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
      const literal = caret?.[1] ?? tilde?.[1] ?? bound?.[2];
      return literal !== undefined && parseSemver(literal) !== undefined;
    });
  });
}
