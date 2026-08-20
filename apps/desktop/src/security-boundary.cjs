const path = require("node:path");

const DESKTOP_CONTROL_HEADER = "x-consistency-desktop-control";
const GENERIC_REGISTRATION_ERROR = "The repository could not be registered. Try again.";
const DUPLICATE_REGISTRATION_ERROR = "This repository is already registered.";

function normalizedRoutePath(value) {
  if (typeof value !== "string") return undefined;
  let decoded = value;
  for (let pass = 0; pass < 4; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return undefined;
    }
  }

  const segments = [];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

/** Renderer-originated requests may never address main/helper-only routes. */
function isBlockedRendererApiPath(pathname) {
  const normalized = normalizedRoutePath(pathname);
  if (normalized === undefined) return true;
  return normalized === "/api/internal"
    || normalized.startsWith("/api/internal/")
    || normalized === "/internal"
    || normalized.startsWith("/internal/");
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Invalid repository ${field}`);
  }
  return value;
}

function optionalString(value, field) {
  return value === undefined ? undefined : requiredString(value, field);
}

function looksLikeAbsolutePath(value) {
  return /^(?:[a-z]:[\\/]|[\\/]{1,2}|file:)/i.test(value);
}

function isSafeExternalUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Copy only the public Repository contract. Never return the API response
 * object itself: internal fields can be added server-side without widening
 * the renderer capability.
 */
function toRendererSafeRepository(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid repository response");
  }

  const id = requiredString(input.id, "id");
  const displayName = requiredString(input.displayName, "displayName");
  const source = requiredString(input.source, "source");
  const remoteFullName = optionalString(input.remoteFullName, "remoteFullName");
  const defaultBranch = optionalString(input.defaultBranch, "defaultBranch");
  const trustLevel = requiredString(input.trustLevel, "trustLevel");
  const createdAt = requiredString(input.createdAt, "createdAt");
  const updatedAt = requiredString(input.updatedAt, "updatedAt");

  if (!["local_git", "github", "gitlab"].includes(source)) {
    throw new TypeError("Invalid repository source");
  }
  if (!["untrusted_readonly", "trusted_local"].includes(trustLevel)) {
    throw new TypeError("Invalid repository trustLevel");
  }
  if (typeof input.monitoringEnabled !== "boolean") {
    throw new TypeError("Invalid repository monitoringEnabled");
  }
  if (source !== "local_git" && remoteFullName === undefined) {
    throw new TypeError("Invalid remote repository response");
  }
  if ([id, displayName, remoteFullName, defaultBranch, createdAt, updatedAt]
    .some(value => value && looksLikeAbsolutePath(value))) {
    throw new TypeError("Repository response contains a local path");
  }

  const repository = {
    id,
    displayName,
    source,
    trustLevel,
    monitoringEnabled: input.monitoringEnabled,
    createdAt,
    updatedAt
  };
  if (remoteFullName !== undefined) repository.remoteFullName = remoteFullName;
  if (defaultBranch !== undefined) repository.defaultBranch = defaultBranch;
  return Object.freeze(repository);
}

function sanitizedRegistrationError(error) {
  return error && typeof error === "object" && error.status === 409
    ? DUPLICATE_REGISTRATION_ERROR
    : GENERIC_REGISTRATION_ERROR;
}

/**
 * The selected path lives only for the duration of this main-process call.
 * The injected registrar is the sole recipient and its response is narrowed
 * before the result crosses IPC.
 */
async function selectAndRegisterRepository({ showOpenDialog, parentWindow, registerRepository }) {
  try {
    const selection = await showOpenDialog(parentWindow, {
      title: "Choose a repository to monitor",
      properties: ["openDirectory", "dontAddToRecent"]
    });
    if (selection.canceled || !Array.isArray(selection.filePaths) || selection.filePaths.length === 0) {
      return Object.freeze({ canceled: true });
    }

    const selectedPath = path.resolve(selection.filePaths[0]);
    const displayName = path.basename(selectedPath) || "Local repository";
    const response = await registerRepository({
      displayName,
      path: selectedPath,
      monitoringEnabled: true
    });
    const repository = toRendererSafeRepository(response && response.repository ? response.repository : response);
    if (repository.source !== "local_git" || repository.trustLevel !== "untrusted_readonly") {
      throw new TypeError("Invalid local repository response");
    }
    return Object.freeze({ canceled: false, repository });
  } catch (error) {
    return Object.freeze({ canceled: false, error: sanitizedRegistrationError(error) });
  }
}

module.exports = Object.freeze({
  DESKTOP_CONTROL_HEADER,
  isBlockedRendererApiPath,
  isSafeExternalUrl,
  sanitizedRegistrationError,
  selectAndRegisterRepository,
  toRendererSafeRepository
});
