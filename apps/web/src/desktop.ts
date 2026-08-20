import type { Repository } from "@consistency/schema";

export const DESKTOP_CREDENTIAL_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PUBLIC_READ_TOKEN"
] as const;

export type DesktopCredentialKey = typeof DESKTOP_CREDENTIAL_KEYS[number];
export type DesktopCredentialStatus = Record<DesktopCredentialKey, boolean>;
export type DesktopRepositorySelection =
  | { readonly canceled: true }
  | { readonly canceled: false; readonly repository: Readonly<Repository> }
  | { readonly canceled: false; readonly error: string };

export type ConsistencyDesktopBridge = {
  appVersion: () => Promise<string>;
  selectRepository: () => Promise<DesktopRepositorySelection>;
  credentialStatus: () => Promise<DesktopCredentialStatus>;
  setCredential: (key: DesktopCredentialKey, value: string | null) => Promise<DesktopCredentialStatus>;
  showFromTray: () => Promise<{ visible: boolean }>;
  restartRuntime?: () => Promise<{ ok: boolean; error?: string }>;
};

declare global {
  interface Window {
    consistencyDesktop?: ConsistencyDesktopBridge;
  }
}

export function desktopBridge(): ConsistencyDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.consistencyDesktop;
}
