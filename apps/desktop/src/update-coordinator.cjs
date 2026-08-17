const UPDATE_CHANNELS = new Set(["stable", "beta"]);
const ACTIVE_PHASES = new Set(["checking", "downloading", "installing"]);
const ELIGIBILITY_REASONS = new Set([
  "ready",
  "development",
  "portable",
  "unsupported-platform",
  "not-installed",
  "unsigned",
  "release-disabled",
  "updater-unavailable"
]);
const NSIS_INSTALL_MARKER = ".consistency-nsis-installed";

const MESSAGES = Object.freeze({
  development: "Automatic updates are available only in an installed release.",
  portable: "Portable builds use manual updates.",
  "unsupported-platform": "Automatic updates are not available on this platform.",
  "not-installed": "This packaged build is not an installed NSIS release.",
  unsigned: "This build is not a signed release and uses manual updates.",
  "release-disabled": "This release was built for manual updates.",
  "updater-unavailable": "The automatic update service is unavailable in this build.",
  busy: "Another update operation is already in progress.",
  "invalid-channel": "The update channel must be stable or beta.",
  "channel-write-failed": "The update channel could not be saved.",
  "no-update": "No update is ready to download.",
  "not-downloaded": "Download the update before installing it.",
  unavailable: "The update service is unavailable. Try again later."
});

function isUpdateChannel(value) {
  return typeof value === "string" && UPDATE_CHANNELS.has(value);
}

function normalizeUpdateChannel(value) {
  return isUpdateChannel(value) ? value : "stable";
}

function providerChannel(channel) {
  return channel === "beta" ? "beta" : "latest";
}

function determineUpdateEligibility({
  isPackaged,
  platform,
  isPortable,
  nsisInstalled,
  signedRelease,
  updateEnabled
}) {
  if (!isPackaged) return Object.freeze({ mode: "manual", reason: "development" });
  if (platform !== "win32") return Object.freeze({ mode: "manual", reason: "unsupported-platform" });
  if (isPortable) return Object.freeze({ mode: "manual", reason: "portable" });
  if (!nsisInstalled) return Object.freeze({ mode: "manual", reason: "not-installed" });
  if (!signedRelease) return Object.freeze({ mode: "manual", reason: "unsigned" });
  if (!updateEnabled) return Object.freeze({ mode: "manual", reason: "release-disabled" });
  return Object.freeze({ mode: "automatic", reason: "ready" });
}

function safeVersion(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return undefined;
  return /^[0-9A-Za-z.+-]+$/.test(value) ? value : undefined;
}

function createUpdateCoordinator({
  eligibility,
  updater,
  initialChannel,
  currentVersion,
  signedRelease,
  persistChannel = async () => {},
  notify = () => {}
}) {
  let mode = eligibility && eligibility.mode === "automatic" ? "automatic" : "manual";
  let reason = eligibility && ELIGIBILITY_REASONS.has(eligibility.reason)
    ? eligibility.reason
    : mode === "automatic" ? "ready" : "updater-unavailable";
  if (mode === "automatic") reason = "ready";
  if (mode === "manual" && reason === "ready") reason = "updater-unavailable";
  let channel = normalizeUpdateChannel(initialChannel);
  let phase = mode === "automatic" ? "idle" : "manual-only";
  let availableVersion;
  let progressPercent;
  let message = mode === "manual" ? MESSAGES[reason] ?? MESSAGES.unavailable : undefined;
  const listeners = [];

  if (mode === "automatic" && (!updater || typeof updater.on !== "function")) {
    mode = "manual";
    reason = "updater-unavailable";
    phase = "manual-only";
    message = MESSAGES[reason];
  }

  function getState() {
    const state = {
      mode,
      reason,
      channel,
      phase,
      currentVersion: safeVersion(currentVersion) ?? "unknown",
      signedRelease: Boolean(signedRelease)
    };
    if (availableVersion !== undefined) state.availableVersion = availableVersion;
    if (progressPercent !== undefined) state.progressPercent = progressPercent;
    if (message !== undefined) state.message = message;
    return Object.freeze(state);
  }

  function actionResult(ok, actionMessage) {
    const result = { ok: Boolean(ok), state: getState() };
    if (actionMessage !== undefined) result.message = actionMessage;
    return Object.freeze(result);
  }

  function broadcast() {
    try {
      notify(getState());
    } catch {
      // A renderer notification failure must not alter updater state.
    }
  }

  function transition(nextPhase, options = {}) {
    phase = nextPhase;
    if (Object.prototype.hasOwnProperty.call(options, "availableVersion")) {
      availableVersion = safeVersion(options.availableVersion);
    }
    if (Object.prototype.hasOwnProperty.call(options, "progressPercent")) {
      const nextProgress = Number(options.progressPercent);
      progressPercent = Number.isFinite(nextProgress)
        ? Math.max(0, Math.min(100, Math.round(nextProgress * 10) / 10))
        : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(options, "message")) message = options.message;
    broadcast();
  }

  function configureUpdater() {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableWebInstaller = true;
    updater.channel = providerChannel(channel);
    updater.allowPrerelease = channel === "beta";
    // electron-updater enables downgrades when assigning channel. Never let a
    // channel switch silently install an older build.
    updater.allowDowngrade = false;
  }

  function listen(eventName, listener) {
    updater.on(eventName, listener);
    listeners.push([eventName, listener]);
  }

  function detachListeners() {
    if (!updater || typeof updater.removeListener !== "function") return;
    for (const [eventName, listener] of listeners) updater.removeListener(eventName, listener);
    listeners.length = 0;
  }

  function fallBackToManual() {
    detachListeners();
    mode = "manual";
    reason = "updater-unavailable";
    phase = "manual-only";
    availableVersion = undefined;
    progressPercent = undefined;
    message = MESSAGES[reason];
  }

  if (mode === "automatic") {
    try {
      configureUpdater();
      listen("checking-for-update", () => {
        transition("checking", { availableVersion: undefined, progressPercent: undefined, message: undefined });
      });
      listen("update-available", info => {
        transition("available", {
          availableVersion: info && info.version,
          progressPercent: undefined,
          message: undefined
        });
      });
      listen("update-not-available", () => {
        transition("not-available", { availableVersion: undefined, progressPercent: undefined, message: undefined });
      });
      listen("download-progress", progress => {
        transition("downloading", { progressPercent: progress && progress.percent, message: undefined });
      });
      listen("update-downloaded", info => {
        transition("downloaded", {
          availableVersion: info && info.version,
          progressPercent: 100,
          message: undefined
        });
      });
      listen("error", () => {
        transition("error", { progressPercent: undefined, message: MESSAGES.unavailable });
      });
    } catch {
      fallBackToManual();
    }
  }

  async function setChannel(nextChannel) {
    if (!isUpdateChannel(nextChannel)) return actionResult(false, MESSAGES["invalid-channel"]);
    if (ACTIVE_PHASES.has(phase) || phase === "downloaded") return actionResult(false, MESSAGES.busy);
    if (nextChannel === channel) return actionResult(true);
    try {
      await persistChannel(nextChannel);
    } catch {
      return actionResult(false, MESSAGES["channel-write-failed"]);
    }
    channel = nextChannel;
    availableVersion = undefined;
    progressPercent = undefined;
    message = mode === "manual" ? MESSAGES[reason] ?? MESSAGES.unavailable : undefined;
    phase = mode === "automatic" ? "idle" : "manual-only";
    if (mode === "automatic") {
      try {
        configureUpdater();
      } catch {
        fallBackToManual();
      }
    }
    broadcast();
    return actionResult(mode === "automatic" || reason !== "updater-unavailable");
  }

  async function check() {
    if (mode !== "automatic") return actionResult(false, message);
    if (ACTIVE_PHASES.has(phase) || phase === "downloaded") return actionResult(false, MESSAGES.busy);
    transition("checking", { availableVersion: undefined, progressPercent: undefined, message: undefined });
    try {
      const result = await updater.checkForUpdates();
      if (phase === "checking") {
        if (result && result.isUpdateAvailable) {
          transition("available", {
            availableVersion: result.updateInfo && result.updateInfo.version,
            message: undefined
          });
        } else {
          transition("not-available", { availableVersion: undefined, message: undefined });
        }
      }
      return actionResult(true);
    } catch {
      transition("error", { progressPercent: undefined, message: MESSAGES.unavailable });
      return actionResult(false, MESSAGES.unavailable);
    }
  }

  async function download() {
    if (mode !== "automatic") return actionResult(false, message);
    if (phase !== "available") return actionResult(false, MESSAGES["no-update"]);
    transition("downloading", { progressPercent: 0, message: undefined });
    try {
      // electron-updater resolves with local installer paths. Intentionally
      // discard that value so it can never cross the IPC boundary.
      await updater.downloadUpdate();
      if (phase === "downloading") transition("downloaded", { progressPercent: 100, message: undefined });
      return actionResult(true);
    } catch {
      transition("error", { progressPercent: undefined, message: MESSAGES.unavailable });
      return actionResult(false, MESSAGES.unavailable);
    }
  }

  function install() {
    if (mode !== "automatic") return actionResult(false, message);
    if (phase !== "downloaded") return actionResult(false, MESSAGES["not-downloaded"]);
    transition("installing", { message: undefined });
    try {
      updater.quitAndInstall(false, true);
      return actionResult(true);
    } catch {
      transition("error", { progressPercent: undefined, message: MESSAGES.unavailable });
      return actionResult(false, MESSAGES.unavailable);
    }
  }

  function dispose() {
    detachListeners();
  }

  return Object.freeze({
    getState,
    setChannel,
    check,
    download,
    install,
    dispose
  });
}

module.exports = Object.freeze({
  NSIS_INSTALL_MARKER,
  createUpdateCoordinator,
  determineUpdateEligibility,
  isUpdateChannel,
  normalizeUpdateChannel,
  providerChannel
});
