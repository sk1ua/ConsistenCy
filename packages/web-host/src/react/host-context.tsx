import React, { createContext, useContext } from "react";
import type { WebHost } from "../boot.js";
import type { SlotName } from "../types.js";

const WebHostContext = createContext<WebHost | null>(null);

export function WebHostProvider({
  host,
  children,
}: {
  host: WebHost;
  children: React.ReactNode;
}): React.ReactElement {
  return <WebHostContext.Provider value={host}>{children}</WebHostContext.Provider>;
}

export function useWebHost(): WebHost {
  const host = useContext(WebHostContext);
  if (!host) {
    throw new Error("useWebHost requires WebHostProvider");
  }
  return host;
}

/** Render a named slot contribution (plugin-owned React node). */
export function Slot({ name, fallback = null }: { name: SlotName; fallback?: React.ReactNode }): React.ReactElement {
  const host = useWebHost();
  return <>{host.ui.slots.get(name) ?? fallback}</>;
}

/**
 * Outlet helper: renders route contributions registered on ui.routes.
 * The HashRouter / React Router tree in apps/web remains authoritative for
 * path matching; this is the extension seam for future route plugins.
 */
export function Outlet({
  fallback = null,
}: {
  fallback?: React.ReactNode;
}): React.ReactElement {
  const host = useWebHost();
  const routes = host.ui.routes.list();
  if (routes.length === 0) return <>{fallback}</>;
  return (
    <>
      {routes.map(route => (
        <React.Fragment key={route.id}>{route.element ?? null}</React.Fragment>
      ))}
    </>
  );
}
