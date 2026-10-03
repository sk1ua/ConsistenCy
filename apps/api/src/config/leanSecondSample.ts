const LEAN_SECOND_SAMPLE_AGENTS = ["Correctness", "Consistency", "Maintainability"] as const;
export type LeanSecondSampleAgent = typeof LEAN_SECOND_SAMPLE_AGENTS[number];

/** Split, trim, and keep only the three lean specialists, in first-seen order. */
export function parseLeanSecondSample(value: string | undefined): readonly LeanSecondSampleAgent[] {
  if (!value) return [];
  const accepted = new Set<string>(LEAN_SECOND_SAMPLE_AGENTS);
  const ignored: string[] = [];
  const agents: LeanSecondSampleAgent[] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (!accepted.has(name)) {
      ignored.push(name);
      continue;
    }
    if (!agents.includes(name as LeanSecondSampleAgent)) agents.push(name as LeanSecondSampleAgent);
  }
  if (ignored.length > 0) console.warn(`Ignoring unknown CONSISTENCY_LEAN_SECOND_SAMPLE agent(s): ${ignored.join(", ")}`);
  return agents;
}
