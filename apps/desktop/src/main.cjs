// ConsistenCy desktop main process.
// Responsibilities: Python 3.12 doctor check, API child process on Electron's
// Node runtime, window hosting the built web UI, minimal IPC surface.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.CONSISTENCY_DESKTOP_PORT ?? 3001);
const DEV_URL = process.env.CONSISTENCY_DESKTOP_DEV_URL;

let apiProcess = null;
let quitting = false;

function log(message) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "consistency.log"), message + "\n");
  } catch {
    // logging is best-effort
  }
}

function stagedRoot() {
  // Development: the repository root (src -> desktop -> apps -> root).
  // Packaged (asar disabled): resources/app/staged.
  if (app.isPackaged) return path.join(app.getAppPath(), "staged");
  return path.resolve(__dirname, "..", "..", "..");
}

function findPython312() {
  // Exit-code based checks with stdio ignored: no pipes are opened, so this
  // works both on normal machines and inside sandboxed environments that
  // forbid capturing child output.
  const versionGate = "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)";
  const candidates = [
    { command: "py", args: ["-3.12", "-c", "pass"] },
    { command: "python", args: ["-c", versionGate] },
    { command: "python3", args: ["-c", versionGate] }
  ];
  for (const { command, args } of candidates) {
    try {
      const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
      if (result.status === 0) return command;
    } catch {
      // candidate missing; try the next
    }
  }
  return undefined;
}

function startApi(python) {
  log("main: startApi begin");
  const root = stagedRoot();
  // Packaged runtime lives in staged/runtime/modules (electron-builder
  // excludes any directory literally named node_modules from its matcher).
  const modulesRoot = app.isPackaged ? path.join(root, "runtime", "modules") : path.join(root, "node_modules");
  const tsxCli = path.join(modulesRoot, "tsx", "dist", "cli.mjs");
  const serverEntry = path.join(root, "apps", "api", "src", "server.ts");
  log("main: root=" + root + " tsx=" + fs.existsSync(tsxCli) + " server=" + fs.existsSync(serverEntry));
  if (!fs.existsSync(tsxCli) || !fs.existsSync(serverEntry)) {
    dialog.showErrorBox(
      "ConsistenCy",
      "API runtime is missing. Run 'npm run desktop:pack' to stage the application, or install dependencies."
    );
    app.quit();
    return;
  }
  const userData = app.getPath("userData");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    // The packaged runtime tree is renamed modules/ (electron-builder drops
    // node_modules dirs), so bare specifiers resolve through NODE_PATH.
    ...(app.isPackaged ? { NODE_PATH: path.join(root, "runtime", "modules") } : {}),
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DATABASE_PATH: path.join(userData, "consistency.db"),
    CONSISTENCY_WORKSPACE_ROOT: path.join(userData, "workspaces"),
    CONSISTENCY_SETTINGS_ROOT: path.join(userData, "settings"),
    CONSISTENCY_ENGINE_ROOT: path.join(root, "engine"),
    CONSISTENCY_PYTHON_PATH: python,
    CONSISTENCY_ALLOWED_ORIGINS: "null,http://127.0.0.1:5173,http://localhost:5173",
    CONSISTENCY_LOAD_ENV_FILE: "false",
    CONSISTENCY_WORKERS_ENABLED: process.env.CONSISTENCY_WORKERS_ENABLED ?? "true",
    CONSISTENCY_HEARTBEAT_ENABLED: process.env.CONSISTENCY_HEARTBEAT_ENABLED ?? "false",
    LLM_PROVIDER: process.env.LLM_PROVIDER ?? "mock"
  };
  let logFd;
  try {
    logFd = fs.openSync(path.join(userData, "api.log"), "a");
  } catch {
    logFd = "ignore";
  }
  apiProcess = spawn(process.execPath, [tsxCli, serverEntry], {
    env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  log("main: API spawned (pid=" + apiProcess.pid + ")");
  apiProcess.on("error", error => {
    log("main: API spawn error: " + (error && error.message ? error.message : String(error)));
    if (!quitting) {
      dialog.showErrorBox("ConsistenCy", "Could not start the API process: " + (error && error.message ? error.message : String(error)));
      app.quit();
    }
  });
  apiProcess.on("exit", code => {
    if (!quitting && code !== 0) {
      dialog.showErrorBox("ConsistenCy", "The API process exited unexpectedly. See the log output.");
    }
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + PORT + "/health");
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return false;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    title: "ConsistenCy",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });
  const distIndex = path.join(stagedRoot(), "apps", "web", "dist", "index.html");
  const url = DEV_URL ?? "file://" + distIndex;
  window.loadURL(url);
}

app.whenReady().then(async () => {
  log("main: ready, searching for Python 3.12");
  const python = findPython312();
  if (!python) {
    log("main: Python 3.12 not found, showing error box");
    dialog.showErrorBox(
      "ConsistenCy",
      "Python 3.12 was not found. ConsistenCy's deterministic engine requires Python 3.12.\n\n" +
        "Install it from https://www.python.org/downloads/ and make sure 'py -3.12' works, then restart the app."
    );
    app.quit();
    return;
  }
  log("main: python=" + python);
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:userDataPath", () => app.getPath("userData"));

  try {
    startApi(python);
  } catch (error) {
    log("main: startApi threw: " + (error && error.stack ? error.stack : String(error)));
    return;
  }
  log("main: waiting for API health");
  const healthy = await waitForHealth(20_000);
  if (!healthy) {
    log("main: API unhealthy after 20s, showing error box");
    dialog.showErrorBox("ConsistenCy", "The API did not become healthy within 20 seconds. See the log output.");
    app.quit();
    return;
  }
  log("main: API healthy, creating window");
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

process.on("uncaughtException", error => {
  log("main: uncaught exception: " + (error && error.stack ? error.stack : String(error)));
});
process.on("unhandledRejection", reason => {
  log("main: unhandled rejection: " + (reason && reason.stack ? reason.stack : String(reason)));
});

app.on("before-quit", () => {
  quitting = true;
  if (apiProcess) {
    try {
      apiProcess.kill();
    } catch {
      // already gone
    }
  }
});
