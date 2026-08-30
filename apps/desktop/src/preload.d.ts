export type DesktopUpdateChannel = "stable" | "beta";
export type DesktopUpdateMode = "automatic" | "manual";
export type DesktopUpdatePhase =
  | "manual-only"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type DesktopUpdateState = Readonly<{
  mode: DesktopUpdateMode;
  reason: string;
  channel: DesktopUpdateChannel;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  signedRelease: boolean;
  availableVersion?: string;
  progressPercent?: number;
  message?: string;
}>;

export type DesktopUpdateActionResult = Readonly<{
  ok: boolean;
  state: DesktopUpdateState;
  message?: string;
}>;

export type DesktopPreferenceKey = "closeToTray" | "trayEnabled" | "launchAtLogin";

export type DesktopPreferences = Readonly<{
  closeToTray: boolean;
  trayEnabled: boolean;
  launchAtLogin: boolean;
}>;

export type DesktopPreferencesPatch = Partial<Record<DesktopPreferenceKey, boolean>>;

export type DesktopPreferencesBridge = Readonly<{
  get: () => Promise<DesktopPreferences>;
  set: (patch: DesktopPreferencesPatch) => Promise<DesktopPreferences>;
}>;

export type DesktopUpdateBridge = Readonly<{
  getState: () => Promise<DesktopUpdateState>;
  setChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateActionResult>;
  check: () => Promise<DesktopUpdateActionResult>;
  download: () => Promise<DesktopUpdateActionResult>;
  install: () => Promise<DesktopUpdateActionResult>;
  onStateChange: (callback: (state: DesktopUpdateState) => void) => () => void;
}>;
