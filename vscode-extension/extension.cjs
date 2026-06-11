const fs = require("fs");
const fsp = fs.promises;
const childProcess = require("child_process");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const {
  buildGraph,
  collectRelevantFiles,
  createCustomSource,
  discoverSources,
  isCodexLogPath,
  normalizePath,
  parseUsageFile,
  pathExists,
  summarizeRecords
} = require("./core/tracker-core.cjs");

const STORE_FILE = "tracker-ledger.json";

function activate(context) {
  const tracker = new UsageTracker(context);
  const dashboard = new GraphDashboardProvider(context, tracker);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
  status.command = "aiTokenTracker.openDashboard";
  status.tooltip = "Open Codex Token Tracker";
  status.show();

  context.subscriptions.push({ dispose: () => tracker.dispose() });
  context.subscriptions.push(status);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("aiTokenTracker.graphView", dashboard));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.openDashboard", () => dashboard.openPanel()));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.rescan", () => tracker.scan({ force: true, notify: true })));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.addSource", () => tracker.addSource()));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.exportLedger", () => tracker.exportLedger()));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.openStorage", () => tracker.openStorage()));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.rescanInstallations", () => tracker.refreshInstallation({ notify: true })));
  context.subscriptions.push(vscode.commands.registerCommand("aiTokenTracker.showCaptureLimits", () => showCaptureLimits()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("aiTokenTracker")) {
      tracker.restart();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => tracker.emit()));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => tracker.emit()));
  context.subscriptions.push(tracker.onDidChangeState((state) => {
    const current = state.currentFolder?.summary || {};
    const tokens = formatCompact(current.totalTokens || 0);
    const accuracy = current.reportedTokenShare || 0;
    const live = state.capture?.mode === "realtime" ? "live" : "poll";
    const folderName = state.currentWorkspace?.name || "No folder";
    status.text = `$(graph) Codex ${tokens}`;
    status.tooltip = `${folderName}: ${current.recordCount || 0} turns, ${accuracy}% reported token coverage, ${live} capture`;
    dashboard.postState();
  }));

  tracker.init().catch((error) => {
    vscode.window.showErrorMessage(`Codex Token Tracker failed to start: ${error.message}`);
  });
}

function deactivate() {}

function showCaptureLimits() {
  vscode.window.showInformationMessage(
    "Codex Token Tracker captures submitted Codex prompts, responses, model names, and token usage from local Codex JSONL session logs in near real time. It uses Codex's reported last_token_usage for exact per-turn counts."
  );
}

class UsageTracker {
  constructor(context) {
    this.context = context;
    this.storePath = path.join(context.globalStorageUri.fsPath, STORE_FILE);
    this.state = createEmptyState();
    this.watchers = [];
    this.changedFileQueue = new Map();
    this.changedFileTimer = null;
    this.scanTimer = null;
    this.processTimer = null;
    this.scanPromise = null;
    this.emitTimer = null;
    this.recordsRevision = 0;
    this.publicStateCache = null;
    this.publicStateCacheRevision = -1;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeState = this.changeEmitter.event;
  }

  async init() {
    await fsp.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    await this.loadStore();
    await this.refreshSources();
    await this.refreshInstallation({ save: true });
    this.startWatchers();
    this.startTimer();
    this.startProcessTimer();
    await this.scan({ force: false });
  }

  async restart() {
    this.disposeWatchers();
    this.stopTimer();
    this.stopProcessTimer();
    await this.refreshSources();
    await this.refreshInstallation({ save: true });
    this.startWatchers();
    this.startTimer();
    this.startProcessTimer();
    await this.scan({ force: false });
  }

  dispose() {
    this.disposeWatchers();
    this.stopTimer();
    this.stopProcessTimer();
    this.clearChangedFileTimer();
    this.clearEmitTimer();
    this.changeEmitter.dispose();
  }

  getConfig() {
    const config = vscode.workspace.getConfiguration("aiTokenTracker");
    return {
      enabled: config.get("enabled", true),
      sources: config.get("sources", []),
      fullScanIntervalMs: Math.max(10000, Number(config.get("fullScanIntervalMs", config.get("scanIntervalMs", 60000)))),
      realtimeCapture: config.get("realtimeCapture", true),
      realtimeDebounceMs: Math.max(100, Math.min(5000, Number(config.get("realtimeDebounceMs", 750)))),
      maxRealtimeBatchFiles: Math.max(1, Math.min(500, Number(config.get("maxRealtimeBatchFiles", 50)))),
      savePromptsAndOutputs: config.get("savePromptsAndOutputs", true),
      maxFileSizeMb: Math.max(1, Number(config.get("maxFileSizeMb", 30))),
      maxFilesPerSource: Math.max(100, Math.min(10000, Number(config.get("maxFilesPerSource", 1000)))),
      webviewRecordLimit: Math.max(50, Math.min(5000, Number(config.get("webviewRecordLimit", 500)))),
      processRefreshIntervalMs: Math.max(3000, Math.min(60000, Number(config.get("processRefreshIntervalMs", 10000)))),
      inputCostPerMillion: Math.max(0, Number(config.get("inputCostPerMillion", 0))),
      cachedInputCostPerMillion: Math.max(0, Number(config.get("cachedInputCostPerMillion", 0))),
      outputCostPerMillion: Math.max(0, Number(config.get("outputCostPerMillion", 0))),
      reasoningOutputCostPerMillion: Math.max(0, Number(config.get("reasoningOutputCostPerMillion", 0)))
    };
  }

  getWorkspaceSnapshot() {
    const folders = (vscode.workspace.workspaceFolders || []).map((folder, index) => ({
      index,
      name: folder.name || path.basename(folder.uri.fsPath) || folder.uri.fsPath,
      path: folder.uri.fsPath
    }));
    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : null;
    const activePath = activeUri?.scheme === "file" ? activeUri.fsPath : null;
    const current = activeFolder
      ? folders.find((folder) => normalizeFsPath(folder.path) === normalizeFsPath(activeFolder.uri.fsPath)) || folders[0] || null
      : folders[0] || null;

    return {
      folders,
      current,
      activeFilePath: activePath
    };
  }

  getPublicState(options = {}) {
    if (!this.publicStateCache || this.publicStateCacheRevision !== this.recordsRevision) {
      const records = [...this.state.records].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      this.publicStateCache = {
        records,
        summary: summarizeRecords(records),
        graph: buildGraph(records)
      };
      this.publicStateCacheRevision = this.recordsRevision;
    }

    const workspace = this.getWorkspaceSnapshot();
    const currentFolderRecords = workspace.current
      ? this.publicStateCache.records.filter((record) => recordMatchesWorkspace(record, workspace.current.path))
      : [];
    const recordLimit = Number(options.recordLimit || 0);
    const useCurrentOnly = Boolean(options.currentFolderOnly);
    const baseRecords = useCurrentOnly ? currentFolderRecords : this.publicStateCache.records;
    const records = recordLimit > 0 ? baseRecords.slice(0, recordLimit) : baseRecords;
    const currentRecords = recordLimit > 0 ? currentFolderRecords.slice(0, recordLimit) : currentFolderRecords;
    const config = this.getConfig();
    const currentSummary = summarizeRecords(currentFolderRecords);
    const currentGraph = buildGraph(currentFolderRecords);
    const currentAnalytics = buildAnalytics(currentFolderRecords, config);

    return {
      ...this.state,
      records,
      totalRecordCount: baseRecords.length,
      summary: useCurrentOnly ? currentSummary : this.publicStateCache.summary,
      graph: useCurrentOnly ? currentGraph : this.publicStateCache.graph,
      analytics: useCurrentOnly ? currentAnalytics : buildAnalytics(this.publicStateCache.records, config),
      workspace,
      workspaceFolders: workspace.folders,
      currentWorkspace: workspace.current,
      currentFolder: {
        workspace: workspace.current,
        records: currentRecords,
        totalRecordCount: currentFolderRecords.length,
        summary: currentSummary,
        graph: currentGraph,
        analytics: currentAnalytics
      },
      storagePath: this.storePath
    };
  }

  async loadStore() {
    try {
      const raw = await fsp.readFile(this.storePath, "utf8");
      this.state = { ...createEmptyState(), ...JSON.parse(raw) };
      this.state.sources = (this.state.sources || []).filter((source) => source.kind === "codex" || String(source.id || "").includes("codex"));
      this.state.records = (this.state.records || []).filter((record) => isCodexRecord(record));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.state = createEmptyState();
      await this.saveStore();
    }
  }

  async saveStore() {
    this.state.updatedAt = new Date().toISOString();
    const tempPath = `${this.storePath}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    await fsp.rename(tempPath, this.storePath);
  }

  async refreshSources() {
    const config = this.getConfig();
    this.state.sources = await discoverSources(this.state.sources, config.sources);
    await this.saveStore();
    this.emit();
  }

  async refreshInstallation({ save = false, notify = false } = {}) {
    this.state.installation = await scanCodexInstallation(this.state.sources || []);
    if (save) {
      await this.saveStore();
    }
    this.emit();
    if (notify) {
      vscode.window.showInformationMessage(`Codex Token Tracker found ${this.state.installation.locations.length} Codex locations and ${this.state.installation.processes.length} related processes.`);
    }
  }

  startTimer() {
    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }
    this.stopTimer();
    this.scanTimer = setInterval(() => {
      this.scan({ force: false }).catch(() => {});
    }, config.fullScanIntervalMs);
  }

  stopTimer() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  startProcessTimer() {
    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }
    this.stopProcessTimer();
    this.processTimer = setInterval(() => {
      refreshCodexProcesses().then((processes) => {
        this.state.installation.processes = processes;
        this.state.installation.lastProcessRefreshAt = new Date().toISOString();
        this.scheduleEmit();
      }).catch((error) => {
        this.state.installation.errors = [...(this.state.installation.errors || []), error.message].slice(-5);
        this.scheduleEmit();
      });
    }, config.processRefreshIntervalMs);
  }

  stopProcessTimer() {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  startWatchers() {
    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }

    this.disposeWatchers();
    this.clearChangedFileTimer();
    const scheduleScan = debounce(() => {
      this.scan({ force: false }).catch(() => {});
    }, 1000);

    for (const source of this.state.sources) {
      if (!source.enabled || !source.exists) {
        continue;
      }

      try {
        const watcher = fs.watch(
          source.rootPath,
          { recursive: process.platform === "win32" || process.platform === "darwin" },
          (_eventType, fileName) => {
            if (!config.realtimeCapture || !fileName) {
              scheduleScan();
              return;
            }

            const changedPath = path.resolve(source.rootPath, String(fileName));
            if (!isRelevantLogPath(changedPath)) {
              return;
            }

            this.queueChangedFile(source.id, changedPath);
          }
        );
        this.watchers.push(watcher);
      } catch {
        // Polling still covers platforms or paths that cannot be watched.
      }
    }
  }

  disposeWatchers() {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    this.watchers = [];
  }

  queueChangedFile(sourceId, filePath) {
    this.changedFileQueue.set(normalizePath(filePath), { sourceId, filePath });
    this.state.capture.lastEventAt = new Date().toISOString();
    this.state.capture.pendingFiles = this.changedFileQueue.size;
    this.state.capture.mode = "realtime";
    this.scheduleEmit();

    this.clearChangedFileTimer();
    const config = this.getConfig();
    this.changedFileTimer = setTimeout(() => {
      this.flushChangedFiles().catch((error) => {
        this.state.capture.lastError = error.message;
        this.emit();
      });
    }, config.realtimeDebounceMs);
  }

  clearChangedFileTimer() {
    if (this.changedFileTimer) {
      clearTimeout(this.changedFileTimer);
      this.changedFileTimer = null;
    }
  }

  clearEmitTimer() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
  }

  scheduleEmit() {
    if (this.emitTimer) {
      return;
    }

    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, 150);
  }

  async flushChangedFiles() {
    if (this.scanPromise) {
      const config = this.getConfig();
      this.clearChangedFileTimer();
      this.changedFileTimer = setTimeout(() => {
        this.flushChangedFiles().catch(() => {});
      }, config.realtimeDebounceMs);
      return;
    }

    const config = this.getConfig();
    const queued = [...this.changedFileQueue.values()].slice(0, config.maxRealtimeBatchFiles);
    for (const item of queued) {
      this.changedFileQueue.delete(normalizePath(item.filePath));
    }
    this.state.capture.pendingFiles = this.changedFileQueue.size;

    if (!queued.length) {
      return;
    }

    const maxFileSize = config.maxFileSizeMb * 1024 * 1024;
    let filesScanned = 0;
    let recordsFound = 0;

    for (const item of queued) {
      const source = this.state.sources.find((candidate) => candidate.id === item.sourceId);
      if (!source?.enabled || !source.exists) {
        continue;
      }

      const result = await this.scanSingleFile(source, item.filePath, { force: false, maxFileSize, config });
      filesScanned += result.filesScanned;
      recordsFound += result.recordsFound;
    }

    this.state.capture.lastParsedAt = new Date().toISOString();
    this.state.capture.lastFilesScanned = filesScanned;
    this.state.capture.lastRecordsFound = recordsFound;
    this.state.capture.lastError = null;
    this.state.scan = {
      ...this.state.scan,
      lastFinishedAt: new Date().toISOString(),
      filesScanned,
      recordsFound
    };

    await this.saveStore();
    this.emit();

    if (this.changedFileQueue.size > 0) {
      this.clearChangedFileTimer();
      this.changedFileTimer = setTimeout(() => {
        this.flushChangedFiles().catch(() => {});
      }, config.realtimeDebounceMs);
    }
  }

  async scan({ force = false, notify = false } = {}) {
    if (this.scanPromise) {
      return this.scanPromise;
    }

    this.scanPromise = this.runScan({ force, notify }).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async runScan({ force, notify }) {
    const config = this.getConfig();
    if (!config.enabled) {
      return this.getPublicState();
    }

    await this.refreshSources();
    this.state.scan = {
      ...this.state.scan,
      running: true,
      lastStartedAt: new Date().toISOString(),
      lastError: null,
      filesScanned: 0,
      recordsFound: 0
    };
    this.emit();

    const maxFileSize = config.maxFileSizeMb * 1024 * 1024;
    let filesScanned = 0;
    let recordsFound = 0;

    try {
      for (const source of this.state.sources) {
        if (!source.enabled || !source.exists) {
          continue;
        }

        const files = await collectRelevantFiles(source, {
          maxFileSize,
          maxFiles: config.maxFilesPerSource
        });
        for (const file of files) {
          const result = await this.scanSingleFile(source, file.filePath, { force, maxFileSize, config, fileMeta: file });
          filesScanned += result.filesScanned;
          recordsFound += result.recordsFound;
        }

        source.lastScanAt = new Date().toISOString();
      }

      this.state.scan = {
        ...this.state.scan,
        running: false,
        lastFinishedAt: new Date().toISOString(),
        filesScanned,
        recordsFound,
        lastError: null
      };
      await this.saveStore();
      this.emit();

      if (notify) {
        vscode.window.showInformationMessage(`Codex Token Tracker scanned ${filesScanned} changed files and found ${recordsFound} turns.`);
      }
    } catch (error) {
      this.state.scan = {
        ...this.state.scan,
        running: false,
        lastFinishedAt: new Date().toISOString(),
        lastError: error.message
      };
      await this.saveStore();
      this.emit();
      vscode.window.showErrorMessage(`Codex Token Tracker scan failed: ${error.message}`);
    }

    return this.getPublicState();
  }

  async scanSingleFile(source, filePath, { force, maxFileSize, config, fileMeta = null }) {
    if (!isRelevantLogPath(filePath)) {
      return { filesScanned: 0, recordsFound: 0 };
    }

    let stats = fileMeta;
    if (!stats) {
      try {
        const fileStats = await fsp.stat(filePath);
        if (!fileStats.isFile()) {
          return { filesScanned: 0, recordsFound: 0 };
        }
        stats = {
          size: fileStats.size,
          mtimeMs: fileStats.mtimeMs
        };
      } catch {
        return { filesScanned: 0, recordsFound: 0 };
      }
    }

    if (stats.size === 0 || stats.size > maxFileSize) {
      return { filesScanned: 0, recordsFound: 0 };
    }

    const normalized = normalizePath(filePath);
    const previous = this.state.fileIndex[normalized];
    const unchanged = previous && previous.size === stats.size && previous.mtimeMs === stats.mtimeMs;
    if (!force && unchanged) {
      return { filesScanned: 0, recordsFound: previous.recordCount || 0 };
    }

    let raw;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch {
      return { filesScanned: 0, recordsFound: 0 };
    }

    let records = parseUsageFile({ source, filePath, raw });
    if (!config.savePromptsAndOutputs) {
      records = records.map((record) => ({
        ...record,
        prompt: "[prompt saving disabled]",
        output: "[output saving disabled]"
      }));
    }

    this.replaceRecordsForFile(filePath, records, {
      sourceId: source.id,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      recordCount: records.length,
      scannedAt: new Date().toISOString()
    });

    return { filesScanned: 1, recordsFound: records.length };
  }

  replaceRecordsForFile(filePath, records, fileMeta) {
    const normalized = normalizePath(filePath);
    this.state.records = [
      ...this.state.records.filter((record) => normalizePath(record.filePath) !== normalized),
      ...records
    ];
    this.state.fileIndex[normalized] = fileMeta;
    this.recordsRevision += 1;
  }

  async addSource() {
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Track Folder",
      title: "Choose AI log folder"
    });

    if (!folders?.[0]) {
      return;
    }

    const rootPath = folders[0].fsPath;
    if (!(await pathExists(rootPath))) {
      vscode.window.showWarningMessage("Selected folder does not exist.");
      return;
    }

    const customSource = createCustomSource(rootPath);
    this.state.sources = this.state.sources.filter((source) => source.id !== customSource.id);
    this.state.sources.push(customSource);
    await this.saveStore();
    this.startWatchers();
    await this.scan({ force: true, notify: true });
  }

  async exportLedger({ currentFolderOnly = false } = {}) {
    const publicState = this.getPublicState({ currentFolderOnly });
    const folderName = publicState.currentWorkspace?.name || "current-folder";
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(require("os").homedir(), "Downloads", `${currentFolderOnly ? `codex-${sanitizeFileName(folderName)}-tokens` : "ai-token-ledger"}-${Date.now()}.json`)),
      filters: { JSON: ["json"] },
      title: currentFolderOnly ? "Export current folder Codex token ledger" : "Export AI token ledger"
    });

    if (!target) {
      return;
    }

    await fsp.writeFile(target.fsPath, JSON.stringify({
      exportedAt: new Date().toISOString(),
      scope: currentFolderOnly ? "currentFolder" : "all",
      workspace: currentFolderOnly ? publicState.currentWorkspace : null,
      summary: publicState.summary,
      graph: publicState.graph,
      records: publicState.records
    }, null, 2), "utf8");
    vscode.window.showInformationMessage(`${currentFolderOnly ? "Current folder Codex" : "AI"} token ledger exported to ${target.fsPath}`);
  }

  async openStorage() {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.storePath));
  }

  emit() {
    const config = this.getConfig();
    this.changeEmitter.fire(this.getPublicState({ recordLimit: config.webviewRecordLimit }));
  }
}

class GraphDashboardProvider {
  constructor(context, tracker) {
    this.context = context;
    this.tracker = tracker;
    this.views = new Set();
  }

  resolveWebviewView(webviewView) {
    this.setupWebview(webviewView.webview);
    webviewView.onDidDispose(() => this.views.delete(webviewView.webview));
    this.views.add(webviewView.webview);
    this.postStateTo(webviewView.webview);
  }

  openPanel() {
    const panel = vscode.window.createWebviewPanel(
      "aiTokenTracker.dashboard",
      "Codex Token Tracker",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.setupWebview(panel.webview);
    panel.onDidDispose(() => this.views.delete(panel.webview));
    this.views.add(panel.webview);
    this.postStateTo(panel.webview);
  }

  setupWebview(webview) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webview.html = getDashboardHtml(webview);
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "rescan") {
        await this.tracker.scan({ force: true, notify: true });
      }
      if (message?.type === "addSource") {
        await this.tracker.addSource();
      }
      if (message?.type === "export") {
        await this.tracker.exportLedger({ currentFolderOnly: true });
      }
      if (message?.type === "openStorage") {
        await this.tracker.openStorage();
      }
      if (message?.type === "rescanInstallations") {
        await this.tracker.refreshInstallation({ save: true, notify: true });
      }
      if (message?.type === "showCaptureLimits") {
        showCaptureLimits();
      }
    });
  }

  postState() {
    for (const webview of this.views) {
      this.postStateTo(webview);
    }
  }

  postStateTo(webview) {
    const config = this.tracker.getConfig();
    webview.postMessage({ type: "state", state: this.tracker.getPublicState({ recordLimit: config.webviewRecordLimit, currentFolderOnly: true }) });
  }
}

function getDashboardHtml(webview) {
  const nonce = randomNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Token Tracker</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --panel: color-mix(in srgb, var(--vscode-editor-background), var(--vscode-foreground) 4%);
      --line: color-mix(in srgb, var(--vscode-editor-background), var(--vscode-foreground) 18%);
      --soft-line: color-mix(in srgb, var(--vscode-editor-background), var(--vscode-foreground) 10%);
      --elevated: color-mix(in srgb, var(--vscode-editor-background), var(--vscode-foreground) 7%);
      --green: #48b58a;
      --amber: #d89b2b;
      --rose: #cf6679;
      --cyan: #59a7d8;
      --violet: #a78bfa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button, input {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 10px;
      color: var(--fg);
      background: color-mix(in srgb, var(--panel), var(--vscode-button-secondaryBackground) 28%);
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    button:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--line), var(--cyan) 40%);
      background: var(--elevated);
    }
    button.primary {
      border-color: transparent;
      color: #ffffff;
      background: #2d6a57;
    }
    .shell {
      display: grid;
      gap: 12px;
      padding: 14px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 10;
      border: 1px solid var(--soft-line);
      border-radius: 10px;
      padding: 12px;
      background: color-mix(in srgb, var(--bg), transparent 8%);
      backdrop-filter: blur(16px);
    }
    .title-line {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .title h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.15;
    }
    .title p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      border: 1px solid color-mix(in srgb, var(--green), transparent 42%);
      border-radius: 999px;
      padding: 2px 9px;
      color: color-mix(in srgb, var(--green), var(--fg) 18%);
      background: color-mix(in srgb, var(--green), transparent 86%);
      font-size: 11px;
      font-weight: 700;
    }
    .live-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--green), transparent 78%);
    }
    .live-dot.scanning {
      background: var(--amber);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber), transparent 78%);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(142px, 1fr));
      gap: 10px;
    }
    .panel,
    .folder-hero {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel), transparent 0%);
      box-shadow: 0 12px 28px color-mix(in srgb, #000000, transparent 88%);
      contain: content;
    }
    .card {
      position: relative;
      overflow: hidden;
      min-height: 88px;
      padding: 12px;
      border-color: var(--soft-line);
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .card::before {
      position: absolute;
      inset: 0 0 auto;
      height: 3px;
      background: var(--accent, var(--cyan));
      content: "";
    }
    .card:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--accent, var(--cyan)), var(--line) 40%);
    }
    .card span {
      color: var(--muted);
      font-size: 12px;
    }
    .card strong {
      display: block;
      margin-top: 6px;
      font-size: 22px;
      line-height: 1.05;
    }
    .card em {
      display: block;
      margin-top: 7px;
      color: var(--muted);
      font-size: 11px;
      font-style: normal;
    }
    .card.green { --accent: var(--green); }
    .card.amber { --accent: var(--amber); }
    .card.rose { --accent: var(--rose); }
    .card.cyan { --accent: var(--cyan); }
    .card.violet { --accent: var(--violet); }
    .grid {
      display: grid;
      grid-template-columns: minmax(420px, 1.1fr) minmax(320px, 0.9fr);
      gap: 12px;
    }
    .panel h2 {
      margin: 0;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
      letter-spacing: 0;
    }
    .folder-hero {
      display: grid;
      gap: 0;
      overflow: hidden;
    }
    .folder-hero-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1.4fr) repeat(4, minmax(112px, 0.55fr));
      gap: 12px;
      align-items: stretch;
      padding: 14px;
    }
    .folder-main {
      min-width: 0;
      display: grid;
      align-content: center;
      gap: 8px;
      border-left: 3px solid var(--green);
      padding: 4px 0 4px 12px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .folder-main h2 {
      overflow: hidden;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border: 0;
      padding: 0;
      font-size: 24px;
      line-height: 1.1;
    }
    .folder-path {
      overflow: hidden;
      color: var(--muted);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .folder-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .folder-meta span,
    .token-chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border: 1px solid var(--soft-line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      background: color-mix(in srgb, var(--bg), var(--fg) 3%);
      font-size: 11px;
    }
    .hero-stat {
      border: 1px solid var(--soft-line);
      border-radius: 8px;
      padding: 10px;
      background: color-mix(in srgb, var(--bg), var(--fg) 3%);
    }
    .hero-stat span {
      color: var(--muted);
      font-size: 11px;
    }
    .hero-stat strong {
      display: block;
      margin-top: 6px;
      font-size: 20px;
      line-height: 1;
    }
    .hero-stat em {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      font-style: normal;
    }
    .token-mix {
      display: grid;
      gap: 8px;
      padding: 0 14px 14px;
    }
    .mix-bar {
      display: flex;
      overflow: hidden;
      height: 10px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--line), transparent 25%);
    }
    .mix-segment {
      min-width: 2px;
      height: 100%;
    }
    .mix-input { background: var(--green); }
    .mix-output { background: var(--cyan); }
    .mix-reasoning { background: var(--amber); }
    .mix-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 11px;
    }
    .legend-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: 5px;
      border-radius: 999px;
      vertical-align: middle;
    }
    .bar-list {
      display: grid;
      gap: 10px;
      padding: 12px;
    }
    .bar-row {
      display: grid;
      gap: 8px;
      padding: 11px;
      border: 1px solid var(--soft-line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg), var(--fg) 3%);
    }
    .bar-row.clickable {
      cursor: pointer;
      transition: border-color 100ms ease, background 100ms ease, box-shadow 100ms ease;
    }
    .bar-row.clickable:hover,
    .bar-row.selected {
      border-color: color-mix(in srgb, var(--green), var(--line) 30%);
      background: color-mix(in srgb, var(--green), transparent 91%);
    }
    .bar-row.selected {
      box-shadow: inset 3px 0 0 var(--green);
    }
    .prompt-row {
      width: 100%;
      color: var(--fg);
      text-align: left;
    }
    .prompt-row:hover {
      transform: none;
    }
    .bar-head,
    .bar-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .bar-head strong,
    .bar-meta span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-head strong {
      font-size: 13px;
      line-height: 1.25;
    }
    .bar-head em,
    .bar-meta {
      color: var(--muted);
      font-size: 11px;
      font-style: normal;
    }
    .bar-meta {
      flex-wrap: wrap;
    }
    .bar-meta strong {
      color: var(--fg);
      font-weight: 600;
    }
    .bar-track {
      height: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: color-mix(in srgb, var(--line), transparent 25%);
    }
    .bar-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--green), var(--cyan) 52%, var(--violet));
    }
    .install-grid {
      display: grid;
      grid-template-columns: minmax(360px, 1.2fr) minmax(260px, 0.8fr);
      gap: 12px;
      padding: 10px;
    }
    .mini-heading {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .path-cell {
      max-width: 520px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    td {
      font-size: 12px;
    }
    .ledger-tools {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--line);
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      color: var(--fg);
      background: var(--bg);
    }
    .ledger {
      max-height: 360px;
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .turn {
      display: grid;
      gap: 5px;
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      padding: 10px;
      text-align: left;
      background: transparent;
      transition: background 100ms ease, box-shadow 100ms ease;
    }
    .turn:hover, .turn.selected {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground), transparent 20%);
    }
    .turn.selected {
      box-shadow: inset 3px 0 0 var(--green);
    }
    .turn strong {
      font-size: 12px;
    }
    .turn span {
      color: var(--muted);
      font-size: 11px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 700;
    }
    .ledger-count {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 11px;
    }
    .reported {
      color: #0f513b;
      background: #cdeedd;
    }
    .estimated {
      color: #6c4a00;
      background: #f5df9b;
    }
    .running {
      color: #19456b;
      background: #cfeaff;
    }
    .detail {
      display: grid;
      gap: 10px;
      padding: 12px;
    }
    .detail-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .detail-head strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-head span {
      color: var(--muted);
      font-size: 12px;
    }
    .metric-row {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: color-mix(in srgb, var(--bg), var(--fg) 3%);
    }
    .metric span {
      color: var(--muted);
      font-size: 11px;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
    }
    pre {
      overflow: auto;
      max-height: 170px;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      color: var(--fg);
      background: color-mix(in srgb, var(--bg), #000000 3%);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.45;
    }
    tr:hover td {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground), transparent 35%);
    }
    .empty {
      padding: 24px;
      color: var(--muted);
      text-align: center;
    }
    * {
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--fg), transparent 68%) transparent;
    }
    @media (prefers-reduced-motion: reduce) {
      button,
      .card,
      .turn {
        transition: none;
      }
      button:hover,
      .card:hover {
        transform: none;
      }
    }
    @media (max-width: 880px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .folder-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .folder-main { grid-column: 1 / -1; }
      .install-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="top">
      <div class="title">
        <div class="title-line">
          <h1>Codex Token Tracker</h1>
          <span class="live-badge"><span id="liveDot" class="live-dot"></span><span id="captureMode">Realtime</span></span>
        </div>
        <p id="scanStatus">Waiting for scanner</p>
      </div>
      <div class="actions">
        <button data-action="export">Export</button>
        <button class="primary" data-action="rescan">Rescan</button>
      </div>
    </section>

    <section class="folder-hero" id="folderHero"></section>

    <section class="grid">
      <section class="panel">
        <h2>Current Folder Prompt Usage</h2>
        <div class="ledger-tools"><input id="search" placeholder="Search current folder prompt or model"><span id="ledgerCount" class="ledger-count"></span></div>
        <div id="promptTokenList"></div>
      </section>
      <section class="panel">
        <h2>Prompt Detail</h2>
        <div class="detail" id="detail"></div>
      </section>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = null;
    let selectedId = null;
    let query = "";
    let renderQueued = false;
    let searchTimer = null;

    document.body.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action) {
        vscode.postMessage({ type: action });
      }
      const turn = event.target.closest("[data-turn]");
      if (turn) {
        selectedId = turn.dataset.turn;
        renderPromptTokens();
      }
    });

    document.getElementById("search").addEventListener("input", (event) => {
      query = event.target.value.toLowerCase();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(renderPromptTokens, 90);
    });

    window.addEventListener("message", (event) => {
      if (event.data?.type === "state") {
        state = event.data.state;
        if (!selectedId) {
          const records = scopedRecords();
          selectedId = records[0]?.id || null;
        }
        queueRender();
      }
    });

    function queueRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    }

    function render() {
      if (!state) return;
      const scan = state.scan || {};
      const capture = state.capture || {};
      const mode = scan.running ? "Scanning" : capture.mode === "realtime" ? "Live" : "Polling";
      document.getElementById("captureMode").textContent = mode;
      document.getElementById("liveDot").className = scan.running ? "live-dot scanning" : "live-dot";
      document.getElementById("scanStatus").textContent = scan.running
        ? "Scanning local Codex logs"
        : (capture.mode === "realtime" ? "Live capture" : "Polling") + " / current folder only / last event " + formatDate(capture.lastEventAt);
      renderFolderHero();
      renderPromptTokens();
    }

    function renderFolderHero() {
      const root = document.getElementById("folderHero");
      const workspace = state.currentWorkspace;
      if (!workspace) {
        root.innerHTML = '<div class="empty">Open a VS Code folder to see folder-wise Codex tokens</div>';
        return;
      }

      const summary = state.currentFolder?.summary || {};
      const analytics = state.currentFolder?.analytics || {};
      const records = scopedRecords();
      const latest = records[0]?.timestamp;
      const mixTotal = Math.max(1, Number(summary.inputTokens || 0) + Number(summary.outputTokens || 0) + Number(summary.reasoningOutputTokens || 0));
      const inputPct = Math.round(((summary.inputTokens || 0) / mixTotal) * 100);
      const outputPct = Math.round(((summary.outputTokens || 0) / mixTotal) * 100);
      const reasoningPct = Math.max(0, 100 - inputPct - outputPct);
      root.innerHTML =
        '<div class="folder-hero-grid">' +
          '<div class="folder-main">' +
            '<span class="eyebrow">Current VS Code folder</span>' +
            '<h2 title="' + escapeHtml(workspace.path || workspace.name) + '">' + escapeHtml(workspace.name || "Current folder") + '</h2>' +
            '<div class="folder-path" title="' + escapeHtml(workspace.path || "") + '">' + escapeHtml(workspace.path || "") + '</div>' +
            '<div class="folder-meta"><span>' + formatNumber(summary.recordCount || 0) + ' prompts</span><span>' + (summary.reportedTokenShare || 0) + '% reported</span><span>latest ' + escapeHtml(formatDate(latest)) + '</span></div>' +
          '</div>' +
          heroStat("Total tokens", formatNumber(summary.totalTokens || 0), "folder only") +
          heroStat("Input", formatNumber(summary.inputTokens || 0), formatNumber(summary.cachedInputTokens || 0) + " cached") +
          heroStat("Output", formatNumber(summary.outputTokens || 0), formatNumber(summary.reasoningOutputTokens || 0) + " reasoning") +
          heroStat("Live TPM", formatNumber(analytics.tokensPerMinute || 0), "last 60s") +
        '</div>' +
        '<div class="token-mix">' +
          '<div class="mix-bar"><span class="mix-segment mix-input" style="width:' + inputPct + '%"></span><span class="mix-segment mix-output" style="width:' + outputPct + '%"></span><span class="mix-segment mix-reasoning" style="width:' + reasoningPct + '%"></span></div>' +
          '<div class="mix-legend"><span><i class="legend-dot mix-input"></i>Input ' + formatNumber(summary.inputTokens || 0) + '</span><span><i class="legend-dot mix-output"></i>Output ' + formatNumber(summary.outputTokens || 0) + '</span><span><i class="legend-dot mix-reasoning"></i>Reasoning ' + formatNumber(summary.reasoningOutputTokens || 0) + '</span></div>' +
        '</div>';
    }

    function heroStat(label, value, detail) {
      return '<div class="hero-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong><em>' + escapeHtml(detail || "") + '</em></div>';
    }

    function renderPromptTokens() {
      const allMatches = scopedRecords().filter(matchesQuery);
      const rows = allMatches.slice(0, 80);
      const root = document.getElementById("promptTokenList");
      document.getElementById("ledgerCount").textContent = rows.length ? "showing " + rows.length + " of " + allMatches.length : "";
      if (!rows.length) {
        root.innerHTML = '<div class="empty">No current-folder prompts captured yet</div>';
        document.getElementById("detail").innerHTML = '<div class="empty">No selected prompt</div>';
        return;
      }
      const max = Math.max(...rows.map((row) => row.totalTokens || 0), 1);
      root.innerHTML = '<div class="bar-list">' + rows.map((record) => {
        const width = Math.max(2, Math.round(((record.totalTokens || 0) / max) * 100));
        const selected = record.id === selectedId ? " selected" : "";
        const prompt = record.prompt || "No prompt captured";
        const status = record.status === "running" ? "running" : record.tokenSource;
        return '<button class="bar-row clickable prompt-row' + selected + '" data-turn="' + record.id + '"><div class="bar-head"><strong title="' + escapeHtml(prompt) + '">' + escapeHtml(shortLabel(prompt, 142)) + '</strong><em>' + formatNumber(record.totalTokens) + ' tokens</em></div><div class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></div><div class="bar-meta"><span><strong>' + escapeHtml(record.model || "Codex") + '</strong> / ' + escapeHtml(formatDate(record.timestamp)) + '</span><span>in ' + formatNumber(record.inputTokens) + ' / out ' + formatNumber(record.outputTokens) + ' / reason ' + formatNumber(record.reasoningOutputTokens || 0) + ' <span class="pill ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></span></div></button>';
      }).join("") + '</div>';
      const selected = rows.find((record) => record.id === selectedId) || rows[0];
      selectedId = selected.id;
      renderDetail(selected);
    }

    function scopedRecords() {
      if (!state) {
        return [];
      }
      return state.currentFolder?.records || [];
    }

    function matchesQuery(record) {
      if (!query) {
        return true;
      }
      return [record.model, record.sourceName, record.projectName, record.projectPath, record.prompt, record.output]
        .some((value) => String(value || "").toLowerCase().includes(query));
    }

    function renderDetail(record) {
      const status = record.status === "running" ? "running" : record.tokenSource;
      document.getElementById("detail").innerHTML =
        '<div class="detail-head"><div><strong>' + escapeHtml(record.model || "Codex") + '</strong><span>' + formatDate(record.timestamp) + '</span></div><span class="pill ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></div>' +
        '<div class="metric-row">' +
        metric("Total", formatNumber(record.totalTokens)) +
        metric("Input", formatNumber(record.inputTokens)) +
        metric("Output", formatNumber(record.outputTokens)) +
        metric("Reasoning", formatNumber(record.reasoningOutputTokens || 0)) +
        '</div>' +
        '<div style="color:var(--muted);font-size:12px">Cached input ' + formatNumber(record.cachedInputTokens || 0) + ' / ' + escapeHtml(record.projectPath || "Current folder") + '</div>' +
        '<div><h3>Prompt</h3><pre>' + escapeHtml(record.prompt || "No prompt captured") + '</pre></div>' +
        '<div><h3>Output</h3><pre>' + escapeHtml(record.output || "No output captured") + '</pre></div>';
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
    }

    function formatNumber(value) {
      return new Intl.NumberFormat("en-US").format(Number(value || 0));
    }

    function formatDate(value) {
      if (!value) return "never";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
    }

    function shortLabel(value, length) {
      const text = String(value || "").replace(/\\s+/g, " ").trim();
      return text.length > length ? text.slice(0, length - 3) + "..." : text;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }
  </script>
</body>
</html>`;
}

function buildAnalytics(records, config) {
  const now = Date.now();
  const recent = records.filter((record) => {
    const timestamp = Date.parse(record.completedAt || record.timestamp || "");
    return Number.isFinite(timestamp) && now - timestamp <= 60_000;
  });
  const inputCost = (records.reduce((total, record) => total + (record.inputTokens || 0), 0) / 1_000_000) * config.inputCostPerMillion;
  const cachedCost = (records.reduce((total, record) => total + (record.cachedInputTokens || 0), 0) / 1_000_000) * config.cachedInputCostPerMillion;
  const outputCost = (records.reduce((total, record) => total + (record.outputTokens || 0), 0) / 1_000_000) * config.outputCostPerMillion;
  const reasoningRate = config.reasoningOutputCostPerMillion || config.outputCostPerMillion;
  const reasoningCost = (records.reduce((total, record) => total + (record.reasoningOutputTokens || 0), 0) / 1_000_000) * reasoningRate;
  const costConfigured = config.inputCostPerMillion > 0 || config.outputCostPerMillion > 0 || config.cachedInputCostPerMillion > 0 || config.reasoningOutputCostPerMillion > 0;

  return {
    requestsPerMinute: recent.length,
    tokensPerMinute: recent.reduce((total, record) => total + (record.totalTokens || 0), 0),
    runningTurns: records.filter((record) => record.status === "running").length,
    costConfigured,
    estimatedCost: costConfigured ? inputCost + cachedCost + outputCost + reasoningCost : null,
    costBreakdown: {
      inputCost,
      cachedCost,
      outputCost,
      reasoningCost
    }
  };
}

async function scanCodexInstallation(sources = []) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const codexHome = path.join(home, ".codex");
  const locations = [];
  const errors = [];

  await addLocation(locations, "Codex home", codexHome, "home");
  await addLocation(locations, "Codex sessions", path.join(codexHome, "sessions"), "sessions");
  await addLocation(locations, "Codex config", path.join(codexHome, "config.toml"), "config");
  await addLocation(locations, "Codex auth", path.join(codexHome, "auth.json"), "auth");
  await addLocation(locations, "Codex session index", path.join(codexHome, "session_index.jsonl"), "index");

  const cliPaths = await findCodexCliPaths();
  for (const cliPath of cliPaths) {
    locations.push({ kind: "cli", label: "Codex CLI", path: cliPath, exists: true, detail: "Found on PATH" });
  }

  const extensionRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".windsurf", "extensions")
  ];
  for (const root of extensionRoots) {
    const matches = await findMatchingChildren(root, ["codex", "openai"]);
    for (const match of matches) {
      locations.push({ kind: "vscode-extension", label: "VS Code/Cursor extension", path: match, exists: true, detail: path.basename(match) });
    }
  }

  const storageRoots = [
    path.join(appData, "Code", "User", "globalStorage"),
    path.join(appData, "Code", "User", "workspaceStorage"),
    path.join(appData, "Cursor", "User", "globalStorage"),
    path.join(appData, "Cursor", "User", "workspaceStorage")
  ];
  for (const root of storageRoots) {
    const matches = await findMatchingChildren(root, ["codex", "openai"]);
    for (const match of matches) {
      locations.push({ kind: "storage", label: "Editor storage", path: match, exists: true, detail: path.basename(match) });
    }
  }

  for (const source of sources) {
    if (source.rootPath && !locations.some((location) => normalizeFsPath(location.path) === normalizeFsPath(source.rootPath))) {
      locations.push({ kind: "tracked-source", label: source.label || "Tracked Codex source", path: source.rootPath, exists: Boolean(source.exists), detail: source.enabled ? "Enabled source" : "Disabled source" });
    }
  }

  return {
    lastScannedAt: new Date().toISOString(),
    lastProcessRefreshAt: new Date().toISOString(),
    locations,
    processes: await refreshCodexProcesses().catch((error) => {
      errors.push(error.message);
      return [];
    }),
    errors
  };
}

async function addLocation(locations, label, targetPath, kind) {
  locations.push({
    kind,
    label,
    path: targetPath,
    exists: await pathExists(targetPath),
    detail: kind
  });
}

async function findCodexCliPaths() {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("where.exe", ["codex"], { timeout: 3000 });
    return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function findMatchingChildren(root, keywords) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((entryPath) => keywords.some((keyword) => entryPath.toLowerCase().includes(keyword)))
    .slice(0, 50);
}

async function refreshCodexProcesses() {
  if (process.platform === "win32") {
    const command = "Get-Process -Name code,codex,node -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,CPU,WorkingSet64,StartTime | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { timeout: 5000 });
      if (!stdout.trim()) {
        return [];
      }
      const parsed = JSON.parse(stdout);
      const processes = Array.isArray(parsed) ? parsed : [parsed];
      return processes.map((item) => ({
        name: item.ProcessName,
        pid: item.Id,
        cpuSeconds: Number(item.CPU || 0),
        memoryMb: Math.round(Number(item.WorkingSet64 || 0) / 1024 / 1024),
        startedAt: item.StartTime || null
      }));
    } catch {
      return refreshCodexProcessesFromTasklist();
    }
  }
  return [];
}

async function refreshCodexProcessesFromTasklist() {
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/fo", "csv", "/nh"], { timeout: 5000 });
    return stdout
      .split(/\r?\n/u)
      .map(parseCsvLine)
      .filter((row) => row.length >= 5)
      .filter((row) => /^(code|codex|node)\.exe$/iu.test(row[0]))
      .map((row) => ({
        name: row[0].replace(/\.exe$/iu, ""),
        pid: Number(row[1]),
        cpuSeconds: null,
        memoryMb: parseMemoryMb(row[4]),
        startedAt: null
      }));
  } catch {
    return [];
  }
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: options.timeout || 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseCsvLine(line) {
  const output = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      output.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  output.push(current);
  return output;
}

function parseMemoryMb(value) {
  const numeric = Number(String(value || "").replace(/[^0-9]/gu, ""));
  return Number.isFinite(numeric) ? Math.round(numeric / 1024) : null;
}

function sanitizeFileName(value) {
  return String(value || "current-folder").replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "current-folder";
}

function recordMatchesWorkspace(record, workspacePath) {
  const root = normalizeComparablePath(workspacePath);
  if (!root) {
    return false;
  }

  const projectPath = normalizeComparablePath(record.projectPath);
  if (isSameOrInsidePath(projectPath, root)) {
    return true;
  }

  const workspaceRoots = Array.isArray(record.workspaceRoots) ? record.workspaceRoots : [];
  return workspaceRoots.some((candidate) => {
    const normalized = normalizeComparablePath(candidate);
    return isSameOrInsidePath(normalized, root);
  });
}

function isSameOrInsidePath(candidate, root) {
  if (!candidate || !root) {
    return false;
  }
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}${path.sep}`);
}

function normalizeComparablePath(value) {
  if (!value) {
    return "";
  }
  return path.resolve(String(value)).replace(/[\\/]+$/u, "").toLowerCase();
}

function normalizeFsPath(value) {
  return normalizeComparablePath(value);
}

function createEmptyState() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    sources: [],
    records: [],
    fileIndex: {},
    scan: {
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      filesScanned: 0,
      recordsFound: 0
    },
    capture: {
      mode: "poll",
      lastEventAt: null,
      lastParsedAt: null,
      lastFilesScanned: 0,
      lastRecordsFound: 0,
      pendingFiles: 0,
      lastError: null
    },
    installation: {
      lastScannedAt: null,
      lastProcessRefreshAt: null,
      locations: [],
      processes: [],
      errors: []
    }
  };
}

function isRelevantLogPath(filePath) {
  return isCodexLogPath(filePath);
}

function isCodexRecord(record) {
  const filePath = String(record.filePath || "").toLowerCase();
  return record.sourceKind === "codex" || String(record.sourceId || "").includes("codex") || /[\\/]\.codex[\\/]/u.test(filePath);
}

function debounce(callback, waitMs) {
  let timer = null;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(callback, waitMs);
  };
}

function formatCompact(value) {
  const number = Number(value || 0);
  if (number >= 1000000) {
    return `${(number / 1000000).toFixed(1)}M`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(1)}K`;
  }
  return String(Math.round(number));
}

function randomNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

module.exports = { activate, deactivate };
