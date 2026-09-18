/**
 * Dev-server-only helpers for the Vite `/api` proxy during local web dogfood.
 * Production and Electron must not rely on this — they own auth themselves.
 */

export type DevProxyHeaderBag = {
  getHeader(name: string): string | number | string[] | undefined;
  setHeader(name: string, value: string): void;
};

export type DevProxyAuthEnv = {
  CONSISTENCY_API_TOKEN?: string;
  CONSISTENCY_DESKTOP_CONTROL_TOKEN?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Inject Bearer / desktop-control headers when env tokens are set and absent on the request. */
export function injectDevApiProxyAuth(
  proxyReq: DevProxyHeaderBag,
  env: DevProxyAuthEnv = process.env
): void {
  const apiToken = nonEmpty(env.CONSISTENCY_API_TOKEN);
  if (apiToken && !proxyReq.getHeader("authorization")) {
    proxyReq.setHeader("Authorization", `Bearer ${apiToken}`);
  }

  const desktopToken = nonEmpty(env.CONSISTENCY_DESKTOP_CONTROL_TOKEN);
  if (desktopToken && !proxyReq.getHeader("x-consistency-desktop-control")) {
    proxyReq.setHeader("x-consistency-desktop-control", desktopToken);
  }
}
