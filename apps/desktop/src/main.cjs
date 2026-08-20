// ConsistenCy desktop security boundary.
//
// The main process owns OS lifecycle, the tray, credentials, the restricted
// app protocol and the Node/Python helper lifecycle. Audit orchestration stays
// in the API helper; the renderer receives neither paths nor bearer tokens.
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net: electronNet,
  protocol,
  safeStorage,
  session,
  Tray
} = require("electron");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const nodeNet = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  DESKTOP_CONTROL_HEADER,
  isBlockedRendererApiPath,
  selectAndRegisterRepository
} = require("./security-boundary.cjs");
const {
  NSIS_INSTALL_MARKER,
  createUpdateCoordinator,
  determineUpdateEligibility,
  isUpdateChannel,
  normalizeUpdateChannel
} = require("./update-coordinator.cjs");

const APP_ORIGIN = "consistency://app";
const DEV_URL = process.env.CONSISTENCY_DESKTOP_DEV_URL;
const CREDENTIAL_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PUBLIC_READ_TOKEN"
]);

protocol.registerSchemesAsPrivileged([{
  scheme: "consistency",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true
  }
}]);

let apiProcess = null;
let apiPort = null;
let apiToken = null;
let desktopControlToken = null;
let mainWindow = null;
let tray = null;
let updateCoordinator = null;
let quitting = false;

function log(message) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "consistency.log"), `${message}\n`);
  } catch {
    // Logging is best-effort. Never place credentials or request bodies here.
  }
}

function stagedRoot() {
  if (app.isPackaged) return path.join(app.getAppPath(), "staged");
  return path.resolve(__dirname, "..", "..", "..");
}

function unpackedRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app.asar.unpacked", "staged");
  return stagedRoot();
}

function executableVersion(executable, args = ["--version"]) {
  try {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    });
    return result.status === 0 ? String(result.stdout || result.stderr).trim() : "";
  } catch {
    return "";
  }
}

function resolveNode22() {
  const configured = process.env.CONSISTENCY_NODE_HELPER;
  const packaged = path.join(unpackedRoot(), "runtime", "node", "node.exe");
  const inherited = process.env.npm_node_execpath;
  const candidates = app.isPackaged ? [packaged] : [configured, inherited, "node"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const version = executableVersion(candidate);
    if (/^v(22|23|24|25)\./.test(version)) return candidate;
  }
  return undefined;
}

function resolvePython312() {
  const configured = process.env.CONSISTENCY_PYTHON_PATH;
  const packaged = path.join(unpackedRoot(), "runtime", "python", "python.exe");
  const developmentVenv = path.join(stagedRoot(), ".venv", "Scripts", "python.exe");
  const candidates = app.isPackaged
    ? [packaged]
    : [configured, developmentVenv, "python", "python3"];
  const versionGate = "import sys; print('.'.join(map(str, sys.version_info[:3])))";
  for (const candidate of candidates) {
    if (!candidate) continue;
    const args = ["-c", versionGate];
    if (/^3\.12\./.test(executableVersion(candidate, args))) return { command: candidate };
  }
  return undefined;
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function credentialsPath() {
  return path.join(app.getPath("userData"), "credentials.safe.json");
}

function readEncryptedCredentials() {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    return parsed && parsed.version === 1 && typeof parsed.values === "object" ? parsed.values : {};
  } catch {
    return {};
  }
}

function credentialStatus() {
  const values = readEncryptedCredentials();
  return Object.fromEntries([...CREDENTIAL_KEYS].map(key => [key, typeof values[key] === "string"]));
}

function credentialEnvironment() {
  if (!safeStorage.isEncryptionAvailable()) return {};
  const encrypted = readEncryptedCredentials();
  const environment = {};
  for (const key of CREDENTIAL_KEYS) {
    if (typeof encrypted[key] !== "string") continue;
    try {
      environment[key] = safeStorage.decryptString(Buffer.from(encrypted[key], "base64"));
    } catch {
      log(`credential: unreadable entry for ${key}`);
    }
  }
  return environment;
}

async function writeCredential(key, value) {
  if (!CREDENTIAL_KEYS.has(key)) throw new Error("Credential key is not allowed");
  if (value !== null && (typeof value !== "string" || value.trim().length < 8)) {
    throw new Error("Credential value must contain at least 8 characters");
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
  const payload = { version: 1, values: readEncryptedCredentials() };
  if (value === null) delete payload.values[key];
  else payload.values[key] = safeStorage.encryptString(value).toString("base64");
  const target = credentialsPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporary, target);
  return credentialStatus();
}

function updatePreferencesPath() {
  return path.join(app.getPath("userData"), "desktop-preferences.json");
}

function readDesktopReleaseMetadata() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    return {
      signedRelease: manifest.consistencyDesktopSignedRelease === true,
      updateEnabled: manifest.consistencyDesktopDistribution === "nsis",
      channel: normalizeUpdateChannel(manifest.consistencyDesktopUpdateChannel)
    };
  } catch {
    return { signedRelease: false, updateEnabled: false, channel: "stable" };
  }
}

function readUpdateChannel(releaseChannel) {
  if (isUpdateChannel(process.env.CONSISTENCY_DESKTOP_UPDATE_CHANNEL)) {
    return process.env.CONSISTENCY_DESKTOP_UPDATE_CHANNEL;
  }
  try {
    const preferences = JSON.parse(fs.readFileSync(updatePreferencesPath(), "utf8"));
    if (isUpdateChannel(preferences.updateChannel)) return preferences.updateChannel;
  } catch {
    // Missing or invalid preferences fall back to the signed release metadata.
  }
  return normalizeUpdateChannel(releaseChannel);
}

async function writeUpdateChannel(channel) {
  const target = updatePreferencesPath();
  const temporary = `${target}.${process.pid}.tmp`;
  let preferences = {};
  try {
    const parsed = JSON.parse(await fs.promises.readFile(target, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) preferences = parsed;
  } catch {
    // A new preferences file is expected on first use.
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(temporary, `${JSON.stringify({ ...preferences, updateChannel: channel }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.promises.rename(temporary, target);
}

function broadcastUpdateState(state) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !isTrustedRendererUrl(window.webContents.getURL())) continue;
    window.webContents.send("updates:state-changed", state);
  }
}

function createDesktopUpdateCoordinator() {
  const release = readDesktopReleaseMetadata();
  const eligibility = determineUpdateEligibility({
    isPackaged: app.isPackaged,
    platform: process.platform,
    isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    nsisInstalled: fs.existsSync(path.join(path.dirname(process.execPath), NSIS_INSTALL_MARKER)),
    signedRelease: release.signedRelease,
    updateEnabled: release.updateEnabled
  });
  let updater;
  if (eligibility.mode === "automatic") {
    try {
      ({ autoUpdater: updater } = require("electron-updater"));
    } catch {
      // The coordinator reports updater-unavailable without exposing loader details.
    }
  }
  return createUpdateCoordinator({
    eligibility,
    updater,
    initialChannel: readUpdateChannel(release.channel),
    currentVersion: app.getVersion(),
    signedRelease: release.signedRelease,
    persistChannel: writeUpdateChannel,
    notify: broadcastUpdateState
  });
}

function currentUpdateCoordinator() {
  if (!updateCoordinator) throw new Error("The desktop update coordinator is unavailable");
  return updateCoordinator;
}

function startApi(nodeHelper, python) {
  const root = unpackedRoot();
  const serverEntry = path.join(root, "apps", "api", "dist", "server.cjs");
  const modulesRoot = app.isPackaged
    ? path.join(root, "runtime", "modules")
    : path.join(stagedRoot(), "node_modules");
  if (!fs.existsSync(serverEntry)) {
    throw new Error("The precompiled API is missing. Run the API build before starting Electron.");
  }

  const userData = app.getPath("userData");
  const env = {
    ...process.env,
    ...credentialEnvironment(),
    NODE_ENV: DEV_URL ? "development" : "production",
    NODE_PATH: modulesRoot,
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    DATABASE_PATH: path.join(userData, "consistency.db"),
    CONSISTENCY_WORKSPACE_ROOT: path.join(userData, "workspaces"),
    CONSISTENCY_SETTINGS_ROOT: path.join(userData, "settings"),
    CONSISTENCY_ENGINE_ROOT: path.join(root, "engine"),
    CONSISTENCY_PYTHON_PATH: python.command,
    CONSISTENCY_LOCAL_REVIEW_ROOTS: path.join(userData, "repositories"),
    CONSISTENCY_ALLOWED_ORIGINS: DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN,
    CONSISTENCY_API_TOKEN: apiToken,
    CONSISTENCY_DESKTOP_CONTROL_TOKEN: desktopControlToken,
    CONSISTENCY_LOAD_ENV_FILE: "false",
    CONSISTENCY_WORKERS_ENABLED: process.env.CONSISTENCY_WORKERS_ENABLED ?? "true",
    CONSISTENCY_HEARTBEAT_ENABLED: process.env.CONSISTENCY_HEARTBEAT_ENABLED ?? "false",
    ...(process.env.LLM_PROVIDER ? { LLM_PROVIDER: process.env.LLM_PROVIDER } : {})
  };

  let logFd;
  try {
    logFd = fs.openSync(path.join(userData, "api.log"), "a");
  } catch {
    logFd = "ignore";
  }
  apiProcess = spawn(nodeHelper, [serverEntry], {
    cwd: root,
    env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  log(`main: API helper spawned (pid=${apiProcess.pid})`);
  apiProcess.once("error", error => {
    log(`main: API helper spawn failed: ${error && error.message ? error.message : "unknown"}`);
    if (!quitting) app.quit();
  });
  apiProcess.once("exit", code => {
    if (!quitting && code !== 0) {
      log(`main: API helper exited unexpectedly (${code})`);
      dialog.showErrorBox("ConsistenCy", "The audit service stopped unexpectedly. See the local application log.");
    }
  });
}

async function apiFetch(apiPath, init = {}) {
  if (!apiPort || !apiToken) throw new Error("Audit service is not ready");
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${apiToken}`);
  return electronNet.fetch(`http://127.0.0.1:${apiPort}${apiPath}`, { ...init, headers });
}

async function registerLocalRepository(input) {
  if (!desktopControlToken) throw new Error("Desktop registration is not ready");
  const response = await apiFetch("/internal/repositories/local", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DESKTOP_CONTROL_HEADER]: desktopControlToken
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const error = new Error("Repository registration was rejected");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await apiFetch("/health");
      if (response.ok) return true;
    } catch {
      // The helper is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function restartApi() {
  if (quitting) return { ok: false, error: "Application is shutting down" };
  log("main: runtime restart requested");
  if (apiProcess) {
    try {
      apiProcess.removeAllListeners("exit");
      apiProcess.removeAllListeners("error");
      apiProcess.kill();
    } catch {
      // already stopped
    }
    apiProcess = null;
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const nodeHelper = resolveNode22();
  const python = resolvePython312();
  if (!nodeHelper || !python) {
    throw new Error("Required Node.js 22 or Python 3.12 runtime is unavailable");
  }
  apiPort = DEV_URL
    ? Number(process.env.CONSISTENCY_DESKTOP_PORT ?? 8787)
    : await reserveLoopbackPort();
  apiToken = randomBytes(32).toString("base64url");
  desktopControlToken = randomBytes(32).toString("base64url");
  startApi(nodeHelper, python);
  if (!await waitForHealth(30_000)) {
    throw new Error("The audit service did not become healthy after restart within 30 seconds");
  }
  log(`main: API helper restarted (port=${apiPort})`);
  return { ok: true };
}

function safeAssetPath(url) {
  const webRoot = path.resolve(stagedRoot(), "apps", "web", "dist");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const candidate = path.resolve(webRoot, `.${requested}`);
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${path.sep}`)) return undefined;
  return candidate;
}

async function handleAppProtocol(request) {
  const url = new URL(request.url);
  if (url.hostname !== "app") return new Response("Not found", { status: 404 });
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (isBlockedRendererApiPath(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    const backendPath = url.pathname.slice(4) || "/";
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("content-length");
    headers.delete(DESKTOP_CONTROL_HEADER);
    headers.set("authorization", `Bearer ${apiToken}`);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : undefined;
    if (backendPath === "/settings" && request.method === "PUT" && body) {
      try {
        const patch = JSON.parse(Buffer.from(body).toString("utf8"));
        const containsCredential = Boolean(
          patch?.llm?.deepseekApiKey !== undefined
          || patch?.llm?.openaiApiKey !== undefined
          || patch?.github?.privateKey !== undefined
          || patch?.github?.webhookSecret !== undefined
          || patch?.github?.publicReadToken !== undefined
          || patch?.runtime?.apiToken !== undefined
        );
        if (containsCredential) {
          return Response.json({
            error: {
              code: "DESKTOP_CREDENTIAL_BOUNDARY",
              message: "Desktop credentials must be stored through the protected credential bridge"
            }
          }, { status: 403 });
        }
      } catch {
        // The API owns normal request validation for malformed JSON.
      }
    }
    return electronNet.fetch(`http://127.0.0.1:${apiPort}${backendPath}${url.search}`, {
      method: request.method,
      headers,
      body
    });
  }
  const asset = safeAssetPath(url);
  if (!asset || !fs.existsSync(asset) || !fs.statSync(asset).isFile()) {
    return new Response("Not found", { status: 404 });
  }
  return electronNet.fetch(pathToFileURL(asset).toString());
}

function isTrustedRendererUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "consistency:" && url.hostname === "app") return true;
    return Boolean(DEV_URL && url.origin === new URL(DEV_URL).origin);
  } catch {
    return false;
  }
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame && event.senderFrame.url
    ? event.senderFrame.url
    : event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error("Untrusted IPC sender");
  }
}

function registerIpc() {
  ipcMain.handle("app:version", event => {
    assertTrustedSender(event);
    return app.getVersion();
  });
  ipcMain.handle("repositories:select", async event => {
    assertTrustedSender(event);
    return selectAndRegisterRepository({
      showOpenDialog: dialog.showOpenDialog.bind(dialog),
      parentWindow: mainWindow,
      registerRepository: registerLocalRepository
    });
  });
  ipcMain.handle("credentials:status", event => {
    assertTrustedSender(event);
    return credentialStatus();
  });
  ipcMain.handle("credentials:set", async (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== "object") throw new Error("Credential input is invalid");
    return writeCredential(input.key, input.value);
  });
  ipcMain.handle("tray:show", event => {
    assertTrustedSender(event);
    showWindow();
    return { visible: true };
  });
  ipcMain.handle("runtime:restart", async event => {
    assertTrustedSender(event);
    return restartApi();
  });
  ipcMain.handle("updates:get-state", event => {
    assertTrustedSender(event);
    return currentUpdateCoordinator().getState();
  });
  ipcMain.handle("updates:set-channel", async (event, channel) => {
    assertTrustedSender(event);
    return currentUpdateCoordinator().setChannel(channel);
  });
  ipcMain.handle("updates:check", async event => {
    assertTrustedSender(event);
    return currentUpdateCoordinator().check();
  });
  ipcMain.handle("updates:download", async event => {
    assertTrustedSender(event);
    return currentUpdateCoordinator().download();
  });
  ipcMain.handle("updates:install", async event => {
    assertTrustedSender(event);
    const coordinator = currentUpdateCoordinator();
    if (coordinator.getState().phase !== "downloaded") return coordinator.install();
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Install ConsistenCy update",
      message: "Install the downloaded update and restart ConsistenCy now?",
      buttons: ["Install and restart", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (confirmation.response !== 0) {
      return Object.freeze({
        ok: false,
        state: coordinator.getState(),
        message: "Update installation was canceled."
      });
    }
    return coordinator.install();
  });
}

function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["consistency://app/*"] },
    (details, callback) => callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
          "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          "font-src 'self'; connect-src 'self'"
        ]
      }
    })
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: "#0B0D10",
    autoHideMenuBar: true,
    title: "ConsistenCy",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.on("did-finish-load", () => {
    if (updateCoordinator) window.webContents.send("updates:state-changed", updateCoordinator.getState());
  });
  window.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  mainWindow = window;
  return window;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(process.execPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("ConsistenCy audit supervisor");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open ConsistenCy", click: showWindow },
      { type: "separator" },
      { label: "Quit", click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on("double-click", showWindow);
  } catch (error) {
    log(`main: tray unavailable: ${error && error.message ? error.message : "unknown"}`);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    try {
      hardenSession();
      updateCoordinator = createDesktopUpdateCoordinator();
      registerIpc();
      await protocol.handle("consistency", handleAppProtocol);
      const nodeHelper = resolveNode22();
      const python = resolvePython312();
      if (!nodeHelper || !python) {
        dialog.showErrorBox(
          "ConsistenCy runtime unavailable",
          "The signed Node.js 22 and Python 3.12 audit runtimes are required. Reinstall the application or use the documented development runtime variables."
        );
        app.quit();
        return;
      }
      apiPort = DEV_URL
        ? Number(process.env.CONSISTENCY_DESKTOP_PORT ?? 8787)
        : await reserveLoopbackPort();
      apiToken = randomBytes(32).toString("base64url");
      desktopControlToken = randomBytes(32).toString("base64url");
      startApi(nodeHelper, python);
      if (!await waitForHealth(30_000)) {
        throw new Error("The audit service did not become healthy within 30 seconds");
      }
      createTray();
      createWindow();
      if (updateCoordinator.getState().mode === "automatic") {
        const coordinator = updateCoordinator;
        const updateCheckTimer = setTimeout(() => {
          void coordinator.check();
        }, 5_000);
        updateCheckTimer.unref();
      }
    } catch (error) {
      log(`main: startup failed: ${error && error.stack ? error.stack : "unknown"}`);
      dialog.showErrorBox("ConsistenCy", "The local audit service could not start. See the application log for details.");
      app.quit();
    }
  });
}

app.on("activate", showWindow);
app.on("window-all-closed", () => {
  // Repository monitoring continues while the app is resident in the tray.
});
app.on("before-quit", () => {
  quitting = true;
  if (apiProcess) {
    try { apiProcess.kill(); } catch { /* already gone */ }
  }
  updateCoordinator?.dispose();
  updateCoordinator = null;
  apiToken = null;
  desktopControlToken = null;
});
process.on("uncaughtException", error => log(`main: uncaught exception: ${error && error.stack ? error.stack : "unknown"}`));
process.on("unhandledRejection", reason => log(`main: unhandled rejection: ${reason && reason.stack ? reason.stack : "unknown"}`));
