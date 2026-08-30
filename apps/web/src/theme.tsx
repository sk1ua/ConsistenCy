import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "consistency.theme.v1";

export const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

type ThemeValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  cycle: () => ThemePreference;
};

const fallback: ThemeValue = {
  preference: "system",
  resolved: "light",
  setPreference: () => undefined,
  cycle: () => "dark"
};

export function readThemePreference(storage?: Pick<Storage, "getItem">): ThemePreference {
  let source = storage;
  if (source === undefined && typeof window !== "undefined") {
    try {
      source = window.localStorage;
    } catch {
      return "system";
    }
  }
  if (!source || typeof source.getItem !== "function") return "system";
  try {
    const saved = source.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
  } catch {
    return "system";
  }
  return "system";
}

function defaultPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  return readThemePreference();
}

const ThemeContext = createContext<ThemeValue>(fallback);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(defaultPreference);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );
  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    if (typeof window === "undefined") return;
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      return;
    }
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(STORAGE_KEY, preference);
    } catch {
      // Storage is optional; the resolved theme remains active in memory.
    }
  }, [resolved, preference]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    const legacy = media as MediaQueryList & { addListener?: (listener: (event: MediaQueryListEvent) => void) => void; removeListener?: (listener: (event: MediaQueryListEvent) => void) => void };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => setPreferenceState(next), []);
  const cycle = useCallback(() => {
    const next: ThemePreference =
      preference === "dark" ? "light" : preference === "light" ? "system" : "dark";
    setPreferenceState(next);
    return next;
  }, [preference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, cycle }),
    [preference, resolved, setPreference, cycle]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
