import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrackerService } from "./tracker/tracker-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let trackerService;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "IDE Model Token Tracker",
    backgroundColor: "#f7f6f1",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL("http://127.0.0.1:5173");
  }
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("tracker:state", trackerService.getPublicState());
}

app.whenReady().then(async () => {
  trackerService = new TrackerService({
    dataDir: app.getPath("userData"),
    onStateChange: broadcastState
  });

  await trackerService.init();
  createWindow();

  mainWindow.webContents.once("did-finish-load", () => {
    broadcastState();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (trackerService) {
    await trackerService.stop();
  }
});

ipcMain.handle("tracker:get-state", () => trackerService.getPublicState());

ipcMain.handle("tracker:rescan", async () => {
  const state = await trackerService.rescan({ force: true });
  broadcastState();
  return state;
});

ipcMain.handle("tracker:add-source", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Add IDE or model log folder",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return trackerService.getPublicState();
  }

  const state = await trackerService.addCustomSource(result.filePaths[0]);
  broadcastState();
  return state;
});

ipcMain.handle("tracker:update-source", async (_event, sourceId, patch) => {
  const state = await trackerService.updateSource(sourceId, patch);
  broadcastState();
  return state;
});

ipcMain.handle("tracker:remove-source", async (_event, sourceId) => {
  const state = await trackerService.removeSource(sourceId);
  broadcastState();
  return state;
});

ipcMain.handle("tracker:export-json", async () => {
  const defaultPath = path.join(app.getPath("downloads"), `ide-model-token-tracker-${Date.now()}.json`);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export usage records",
    defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }]
  });

  if (result.canceled || !result.filePath) {
    return trackerService.getPublicState();
  }

  const state = await trackerService.exportJson(result.filePath);
  broadcastState();
  return state;
});

ipcMain.handle("tracker:open-data-folder", async () => {
  await shell.openPath(trackerService.dataDir);
  return trackerService.getPublicState();
});
