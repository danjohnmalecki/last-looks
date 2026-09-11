const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = 8793;

// In dev, the last-looks project lives one directory up. Once packaged,
// electron-builder copies engine/, app/, runtime/ and requirements.txt into
// Resources/last-looks (see package.json "extraResources"). "runtime" is a
// relocatable standalone Python build (python-build-standalone), NOT a venv
// -- a venv bakes in an absolute path back to whatever machine built it,
// which breaks the moment the app is copied anywhere else.
const isPackaged = app.isPackaged;
const lastLooksDir = isPackaged
  ? path.join(process.resourcesPath, "last-looks")
  : path.join(__dirname, "..");

const pythonBin = process.platform === "win32"
  ? path.join(lastLooksDir, "runtime", "python.exe")
  : path.join(lastLooksDir, "runtime", "bin", "python3.12");

let serverProcess = null;
let mainWindow = null;
let serverLog = "";

// Downloading the app through a browser or Slack marks every file inside it
// with com.apple.quarantine. Gatekeeper then silently refuses to exec the
// nested Python binary -- the server never starts and the app just reports a
// timeout, with no clue why. (Downloading via CLI doesn't set the flag, which
// is exactly why this slipped through local testing.) The Electron binary
// itself is already user-approved by this point, so it can clear the flag from
// its own payload. Best-effort: if it fails, we carry on and let the real
// error surface below.
function clearQuarantine() {
  if (process.platform !== "darwin") return;
  try {
    require("child_process").execFileSync(
      "/usr/bin/xattr",
      ["-dr", "com.apple.quarantine", lastLooksDir],
      { timeout: 60000 }
    );
  } catch (err) {
    console.error("Could not clear quarantine (continuing anyway):", err.message);
  }
}

function startServer() {
  clearQuarantine();

  // If a "bin" folder of bundled ffmpeg/tesseract binaries ships alongside the
  // app (see build-desktop.yml), point the engine at it. Otherwise the engine
  // falls back to whatever's on PATH (e.g. Homebrew on Mac).
  const bundledBinDir = path.join(lastLooksDir, "bin");
  const env = { ...process.env };
  const exe = process.platform === "win32" ? ".exe" : "";

  // Apps launched by double-click (not from a Terminal) get a minimal PATH on
  // macOS -- it does NOT include Homebrew's /opt/homebrew/bin (Apple Silicon)
  // or /usr/local/bin (Intel), even though a Terminal session would see them.
  // That's exactly why `brew install ffmpeg` can work perfectly in Terminal
  // and still fail with "No such file or directory: 'ffprobe'" when the app
  // is opened normally. Prepend the common Homebrew locations so the bundled
  // engine can find ffmpeg/ffprobe/tesseract regardless of launch method.
  if (process.platform === "darwin") {
    const extraPaths = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];
    env.PATH = [...extraPaths, env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
  }
  try {
    if (require("fs").existsSync(bundledBinDir)) {
      env.LAST_LOOKS_FFMPEG_BIN = path.join(bundledBinDir, `ffmpeg${exe}`);
      env.LAST_LOOKS_FFPROBE_BIN = path.join(bundledBinDir, `ffprobe${exe}`);
      const tesseractBin = path.join(bundledBinDir, `tesseract${exe}`);
      if (require("fs").existsSync(tesseractBin)) {
        env.LAST_LOOKS_TESSERACT_BIN = tesseractBin;
      }
    }
  } catch (_) { /* no bundled binaries -- fine, use PATH */ }

  serverProcess = spawn(
    pythonBin,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: lastLooksDir, env }
  );

  // Capture the server's output so a startup failure can show the ACTUAL cause
  // on screen. A bare "did not start in time" tells the user (and whoever is
  // debugging it remotely) nothing at all.
  serverProcess.stdout.on("data", (d) => {
    serverLog += d.toString();
    process.stdout.write(d);
  });
  serverProcess.stderr.on("data", (d) => {
    serverLog += d.toString();
    process.stderr.write(d);
  });

  serverProcess.on("error", (err) => {
    serverLog += `\nFailed to launch Python: ${err.message}\n`;
    console.error("Failed to start Last Looks server:", err);
  });
  serverProcess.on("exit", (code, signal) => {
    if (code !== 0) {
      serverLog += `\nPython exited early (code ${code}, signal ${signal}).\n`;
    }
  });
}

// 240 x 500ms = 2 minutes. A cold first launch on a slower machine has to load
// a lot of native libraries; 30s was too tight to distinguish "slow" from "broken".
function waitForServer(retriesLeft = 240) {
  return new Promise((resolve, reject) => {
    const tryOnce = (remaining) => {
      const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (remaining <= 0) {
          reject(new Error("Last Looks server did not start in time"));
          return;
        }
        setTimeout(() => tryOnce(remaining - 1), 500);
      });
    };
    tryOnce(retriesLeft);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: "Last Looks",
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await waitForServer();
    mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  } catch (err) {
    // Surface the real diagnostics -- a screenshot of this screen should be
    // enough to actually identify the problem without remote access.
    const details = [
      `Error: ${err.message}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Python: ${pythonBin}`,
      `Python found on disk: ${require("fs").existsSync(pythonBin)}`,
      "",
      "--- server output ---",
      serverLog.trim() || "(no output -- the Python process produced nothing, " +
        "which usually means the OS blocked it from running)",
    ].join("\n");

    mainWindow.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="font-family:-apple-system,sans-serif;padding:40px;line-height:1.5">
            <h2>Last Looks failed to start</h2>
            <p>Please screenshot this whole window and send it over — the details below say why.</p>
            <pre style="background:#f4f4f6;padding:16px;border-radius:8px;white-space:pre-wrap;
                        word-break:break-word;font-size:12px;max-height:60vh;overflow:auto">${
              details.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])
            }</pre>
          </body>`
        )
    );
  }
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});
