import { useEffect, useState } from "react";

export const WORKBENCH_LAYOUT_STORAGE_KEY = "consistency.workbench-layout.v1";
const VERSION = 1;

export const WORKBENCH_BOUNDS = {
  explorer: { min: 210, max: 420 },
  inspector: { min: 260, max: 520 }
} as const;

export type WorkbenchLayout = {
  explorerCollapsed: boolean;
  explorerWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  ledgerOpen: boolean;
};

const DEFAULT_LAYOUT: WorkbenchLayout = {
  explorerCollapsed: false,
  explorerWidth: 258,
  inspectorOpen: false,
  inspectorWidth: 360,
  ledgerOpen: false
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseWorkbenchLayout(serialized: string | null, fallback: WorkbenchLayout = DEFAULT_LAYOUT): WorkbenchLayout {
  try {
    const parsed = JSON.parse(serialized ?? "null") as Partial<WorkbenchLayout> & { version?: number } | null;
    if (!parsed || parsed.version !== VERSION) return fallback;
    return {
      explorerCollapsed: typeof parsed.explorerCollapsed === "boolean" ? parsed.explorerCollapsed : fallback.explorerCollapsed,
      explorerWidth: clamp(typeof parsed.explorerWidth === "number" ? parsed.explorerWidth : fallback.explorerWidth, WORKBENCH_BOUNDS.explorer.min, WORKBENCH_BOUNDS.explorer.max),
      inspectorOpen: typeof parsed.inspectorOpen === "boolean" ? parsed.inspectorOpen : fallback.inspectorOpen,
      inspectorWidth: clamp(typeof parsed.inspectorWidth === "number" ? parsed.inspectorWidth : fallback.inspectorWidth, WORKBENCH_BOUNDS.inspector.min, WORKBENCH_BOUNDS.inspector.max),
      ledgerOpen: typeof parsed.ledgerOpen === "boolean" ? parsed.ledgerOpen : fallback.ledgerOpen
    };
  } catch {
    return fallback;
  }
}

function readLayout(): WorkbenchLayout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  return parseWorkbenchLayout(window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY), DEFAULT_LAYOUT);
}

export function useWorkbenchLayout() {
  const [layout, setLayout] = useState<WorkbenchLayout>(readLayout);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify({ version: VERSION, ...layout }));
    } catch {
      // Storage may be disabled; layout remains fully functional for this session.
    }
  }, [layout]);

  return {
    layout,
    setExplorerCollapsed: (explorerCollapsed: boolean) => setLayout(current => ({ ...current, explorerCollapsed })),
    setExplorerWidth: (explorerWidth: number) => setLayout(current => ({ ...current, explorerWidth: clamp(explorerWidth, WORKBENCH_BOUNDS.explorer.min, WORKBENCH_BOUNDS.explorer.max) })),
    setInspectorOpen: (inspectorOpen: boolean) => setLayout(current => ({ ...current, inspectorOpen })),
    setInspectorWidth: (inspectorWidth: number) => setLayout(current => ({ ...current, inspectorWidth: clamp(inspectorWidth, WORKBENCH_BOUNDS.inspector.min, WORKBENCH_BOUNDS.inspector.max) })),
    setLedgerOpen: (ledgerOpen: boolean) => setLayout(current => ({ ...current, ledgerOpen }))
  };
}
