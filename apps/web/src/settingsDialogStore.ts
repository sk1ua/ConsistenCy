import { useSyncExternalStore } from "react";

/**
 * Global open/close switch for the settings dialog. The dialog is the single
 * settings surface (the legacy /settings page was ablated): the shell gear,
 * the command palette, and in-page "configure model" calls all go through
 * this store instead of navigating to a route.
 */
let isOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openSettingsDialog(): void {
  if (!isOpen) {
    isOpen = true;
    emit();
  }
}

export function closeSettingsDialog(): void {
  if (isOpen) {
    isOpen = false;
    emit();
  }
}

export function subscribeSettingsDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSettingsDialogOpen(): boolean {
  return isOpen;
}

export function useSettingsDialogOpen(): boolean {
  // The server snapshot mirrors the client snapshot: the dialog never opens
  // during SSR, and renderToString requires the third argument.
  return useSyncExternalStore(subscribeSettingsDialog, getSettingsDialogOpen, getSettingsDialogOpen);
}
