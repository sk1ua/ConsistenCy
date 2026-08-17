const FORWARD_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const BACKWARD_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

export function nextTabId<T extends string>(tabs: readonly T[], current: T, key: string): T | undefined {
  if (tabs.length === 0) return undefined;
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs[tabs.length - 1];
  if (!FORWARD_KEYS.has(key) && !BACKWARD_KEYS.has(key)) return undefined;

  const currentIndex = Math.max(0, tabs.indexOf(current));
  const delta = FORWARD_KEYS.has(key) ? 1 : -1;
  return tabs[(currentIndex + delta + tabs.length) % tabs.length];
}
