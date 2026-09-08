import type { Repository } from "@consistency/schema";

export const DESKTOP_CREDENTIAL_KEYS = [
  "LLM_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PUBLIC_READ_TOKEN"
] as const;

export type DesktopCredentialKey = typeof DESKTOP_CREDENTIAL_KEYS[number];
export type DesktopCredentialStatus = Record<DesktopCredentialKey, boolean>;

export type DesktopGitHubOAuthResult =
  | { status: "connected"; login: string }
  // Device Flow fallback: main proxies the embedded API and consumes the
  // one-time token into safeStorage; these payloads carry no credential.
  | { status: "device-awaiting"; flowId: string; userCode: string; verificationUri: string; intervalSeconds: number }
  | { status: "not_configured" | "denied" | "cancelled" | "expired" | "unavailable" };

export type DesktopGitHubOAuthDevicePollResult =
  | { status: "pending"; retryAfterSeconds: number }
  | { status: "connected"; login: string }
  | { status: "denied" | "expired" | "unavailable" };

export type DesktopGitHubOAuthBridge = {
  start: () => Promise<DesktopGitHubOAuthResult>;
  pollDeviceFlow: (input: { flowId: string }) => Promise<DesktopGitHubOAuthDevicePollResult>;
  cancel: () => Promise<{ status: "cancelled" }>;
};
export type DesktopRepositorySelection =
  | { readonly canceled: true }
  | { readonly canceled: false; readonly repository: Readonly<Repository> }
  | { readonly canceled: false; readonly error: string };

export type DesktopBuildInfo = {
  version: string;
  commitSha: string;
  buildMode: "packaged" | "development" | "manual" | "release";
};

/** Desktop host behavior preferences owned by the Electron main process
 *  (desktop-preferences.json). Defaults: closeToTray on, trayEnabled on,
 *  launchAtLogin off. */
export type DesktopPreferenceKey = "closeToTray" | "trayEnabled" | "launchAtLogin";

export type DesktopPreferences = Readonly<{
  closeToTray: boolean;
  trayEnabled: boolean;
  launchAtLogin: boolean;
}>;

export type DesktopPreferencesPatch = Partial<Record<DesktopPreferenceKey, boolean>>;

/** Identity-only projection of DesktopBuildInfo consumed by renderer surfaces
 *  (About rows, settings badge) that do not care about buildMode. */
export type BuildInfoSummary = {
  version: string;
  commitSha: string;
};

export type ConsistencyDesktopBridge = {
  appVersion: () => Promise<string>;
  buildInfo?: () => Promise<DesktopBuildInfo>;
  selectRepository: () => Promise<DesktopRepositorySelection>;
  credentialStatus: () => Promise<DesktopCredentialStatus>;
  setCredential: (key: DesktopCredentialKey, value: string | null) => Promise<DesktopCredentialStatus>;
  /** Short UI values only (device-flow user code); main validates and size-caps. */
  copyText?: (text: string) => Promise<void>;
  githubOAuth?: DesktopGitHubOAuthBridge;
  showFromTray: () => Promise<{ visible: boolean }>;
  /** Desktop behavior preferences. The main process validates the patch and
   *  applies the OS side effects (tray lifecycle, login item); only boolean
   *  values for the three known keys cross the bridge. */
  preferences?: {
    get: () => Promise<DesktopPreferences>;
    set: (patch: DesktopPreferencesPatch) => Promise<DesktopPreferences>;
  };
  restartRuntime?: () => Promise<{ ok: boolean; error?: string }>;
  /** Semantic desktop action: opens the host's own logs folder. Zero arguments,
   *  boolean-only result — the renderer never supplies or learns a path. */
  openLogsFolder?: () => Promise<{ ok: boolean }>;
};

declare global {
  interface Window {
    consistencyDesktop?: ConsistencyDesktopBridge;
  }
}

export function desktopBridge(): ConsistencyDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.consistencyDesktop;
}

export function openExternalUrl(url: string): void {
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
