import { useCallback, useEffect, useState } from "react";

/**
 * Collapsible + resizable left navigation rail state for the AppShell
 * (>= 980px only). The key is versioned under the v3 namespace so it can
 * never collide with older shell keys; the width is clamped to the shell
 * bounds and every write is debounced so pointer drags do not storm
 * localStorage.
 */
export const SIDEBAR_LAYOUT_STORAGE_KEY = "consistency.v3.sidebar-layout";
export const SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 360 } as const;
export const SIDEBAR_COLLAPSED_WIDTH = 56;
export const SIDEBAR_WIDE_MEDIA_QUERY = "(min-width: 980px)";

const VERSION = 1;
const DEFAULT_WIDTH = 230;
const PERSIST_DEBOUNCE_MS = 120;

export type SidebarLayout = {
  collapsed: boolean;
  width: number;
};

const DEFAULT_LAYOUT: SidebarLayout = {
  collapsed: false,
  width: DEFAULT_WIDTH
};

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_BOUNDS.max, Math.max(SIDEBAR_WIDTH_BOUNDS.min, Math.round(width)));
}

export function parseSidebarLayout(serialized: string | null, fallback: SidebarLayout = DEFAULT_LAYOUT): SidebarLayout {
  try {
    const parsed = JSON.parse(serialized ?? "null") as Partial<SidebarLayout> & { version?: number } | null;
    if (!parsed || parsed.version !== VERSION) return fallback;
    return {
      collapsed: typeof parsed.collapsed === "boolean" ? parsed.collapsed : fallback.collapsed,
      width: clampWidth(typeof parsed.width === "number" ? parsed.width : fallback.width)
    };
  } catch {
    return fallback;
  }
}

function readLayout(): SidebarLayout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  return parseSidebarLayout(window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY));
}

function readWideViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(SIDEBAR_WIDE_MEDIA_QUERY).matches;
}

export function useSidebarLayout() {
  const [layout, setLayout] = useState<SidebarLayout>(readLayout);
  const [isWideViewport, setIsWideViewport] = useState(readWideViewport);

  // The collapse/resize capability is gated to >= 980px: below that width the
  // existing responsive behavior stays untouched.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(SIDEBAR_WIDE_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsWideViewport(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Debounced persistence: drags fire many updates per second while a single
  // trailing write is enough. Storage failures keep the layout session-only.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify({ version: VERSION, ...layout }));
      } catch {
        // Storage may be disabled; layout remains fully functional for this session.
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [layout]);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setLayout(current => ({ ...current, collapsed }));
  }, []);

  const setWidth = useCallback((width: number) => {
    setLayout(current => ({ ...current, width: clampWidth(width) }));
  }, []);

  return { ...layout, isWideViewport, setCollapsed, setWidth };
}
