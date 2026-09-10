const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = 8793;

// In dev, the last-looks project lives one directory up. Once packaged,
// electron-builder copies engine/, app/, .venv/ and requirements.txt into
// Resources/last-looks (see package.json "extraResources").
const isPackaged = app.isPackaged;
const lastLooksDir = isPackaged
  ? path.join(process.resourcesPath, "last-looks")
  : path.join(__dirname, "..");

const pythonBin = path.join(lastLooksDir, ".venv", "bin", "python3");

let serverProcess = null;
let mainWindow = null;

function startServer() {
  serverProcess = spawn(
    pythonBin,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: lastLooksDir, stdio: "inherit" }
  );

  serverProcess.on("error", (err) => {
    console.error("Failed to start Last Looks server:", err);
  });
}

function waitForServer(retriesLeft = 60) {
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
    mainWindow.loadURL(
      `data:text/html,<body style="font-family:-apple-system,sans-serif;padding:40px">` +
        `<h2>Last Looks failed to start</h2><p>${err.message}</p></body>`
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
