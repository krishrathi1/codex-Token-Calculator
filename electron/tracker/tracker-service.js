import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { collectRelevantFiles } from "./files.js";
import { parseUsageFile } from "./parsers.js";
import { createCustomSource, discoverSources, isAiRelatedPath, pathExists } from "./sources.js";
import { normalizePath, TrackerStore } from "./store.js";

const RELEVANT_REALTIME_EXTENSIONS = new Set([".jsonl", ".ndjson", ".json", ".log", ".txt"]);
const DEFAULT_REALTIME_DEBOUNCE_MS = 500;

export class TrackerService {
  constructor({ dataDir, onStateChange }) {
    this.dataDir = dataDir;
    this.onStateChange = onStateChange;
    this.store = new TrackerStore(path.join(dataDir, "tracker-store.json"));
    this.watchers = [];
    this.scanTimer = null;
    this.scanPromise = null;
    this.pendingScan = null;
    this.changedFileQueue = new Map();
    this.changedFileTimer = null;
  }

  async init() {
    await this.store.load();
    await this.refreshSources();
    await this.rescan({ force: false });
    this.start();
  }

  start() {
    this.stopTimers();
    this.startWatchers();

    const intervalMs = this.store.getState().settings.scanIntervalMs;
    this.scanTimer = setInterval(() => {
      this.rescan({ force: false }).catch((error) => {
        this.store.setScan({ lastError: error.message, running: false });
      });
    }, intervalMs);
  }

  async stop() {
    this.stopTimers();
    this.stopChangedFileTimer();
    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
  }

  stopTimers() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  startWatchers() {
    Promise.all(this.watchers.map((watcher) => watcher.close())).catch(() => {});
    this.watchers = [];

    for (const source of this.store.getState().sources) {
      if (!source.enabled || !source.exists) {
        continue;
      }

      const watcher = chokidar.watch(source.rootPath, {
        ignoreInitial: true,
        depth: 8,
        awaitWriteFinish: {
          stabilityThreshold: 1_000,
          pollInterval: 250
        }
      });

      const schedule = (filePath) => {
        this.queueChangedFile(source.id, filePath);
      };

      watcher.on("add", schedule);
      watcher.on("change", schedule);
      this.watchers.push(watcher);
    }

    this.store.setCapture({
      mode: this.watchers.length > 0 ? "realtime" : "polling",
      pendingFiles: this.changedFileQueue.size
    }).then(() => this.onStateChange?.()).catch(() => {});
  }

  getPublicState() {
    const state = this.store.getState();
    const records = state.records.map(({ hasReportedUsage, ...record }) => record);

    return {
      ...state,
      records,
      summary: summarize(records),
      analytics: buildAnalytics(records),
      dataDir: this.dataDir
    };
  }

  async refreshSources() {
    const sources = await discoverSources(this.store.getState().sources);
    await this.store.setSources(sources);
  }

  async rescan({ force = false } = {}) {
    if (this.scanPromise) {
      this.pendingScan = {
        force: Boolean(force || this.pendingScan?.force)
      };
      await this.store.setCapture({
        pendingRescan: true,
        lastEventAt: new Date().toISOString()
      });
      this.onStateChange?.();
      return this.scanPromise;
    }

    this.scanPromise = this.runScan(force)
      .catch(async (error) => {
        await this.store.setScan({
          running: false,
          lastError: error.message,
          lastFinishedAt: new Date().toISOString()
        });
        await this.store.setCapture({
          lastError: error.message,
          pendingRescan: false
        });
        return this.getPublicState();
      })
      .finally(() => {
        this.scanPromise = null;
        const pending = this.pendingScan;
        this.pendingScan = null;
        if (pending) {
          queueMicrotask(() => {
            this.rescan(pending).catch(() => {});
          });
        }
      });

    return this.scanPromise;
  }

  async runScan(force) {
    await this.refreshSources();
    await this.store.setScan({
      running: true,
      lastStartedAt: new Date().toISOString(),
      lastError: null,
      filesScanned: 0,
      recordsFound: 0
    });
    await this.store.setCapture({
      pendingRescan: false,
      lastError: null
    });
    this.onStateChange?.();

    let filesScanned = 0;
    let recordsFound = 0;
    const state = this.store.getState();
    let lastProgressAt = Date.now();

    for (const source of state.sources) {
      if (!source.enabled || !source.exists) {
        continue;
      }

      const files = await collectRelevantFiles(source);
      for (const file of files) {
        const result = await this.scanSingleFile(source, file.filePath, {
          force,
          fileMeta: file
        });

        filesScanned += result.filesScanned;
        recordsFound += result.recordsFound;

        const shouldPublishProgress = result.filesScanned > 0 && Date.now() - lastProgressAt > 300;
        if (shouldPublishProgress) {
          await this.store.setScan({ filesScanned, recordsFound });
          this.onStateChange?.();
          lastProgressAt = Date.now();
        }
      }

      source.lastScanAt = new Date().toISOString();
    }

    await this.store.setSources(state.sources);
    await this.store.setScan({
      running: false,
      lastFinishedAt: new Date().toISOString(),
      filesScanned,
      recordsFound
    });
    await this.store.setCapture({
      lastParsedAt: new Date().toISOString(),
      lastFilesScanned: filesScanned,
      lastRecordsFound: recordsFound,
      pendingFiles: this.changedFileQueue.size,
      pendingRescan: Boolean(this.pendingScan),
      lastError: null
    });
    await this.store.save();
    this.onStateChange?.();

    return this.getPublicState();
  }

  queueChangedFile(sourceId, filePath) {
    if (!filePath || !isRealtimeFilePath(filePath)) {
      return;
    }

    this.changedFileQueue.set(normalizePath(filePath), { sourceId, filePath });
    this.store.setCapture({
      mode: "realtime",
      lastEventAt: new Date().toISOString(),
      pendingFiles: this.changedFileQueue.size,
      pendingRescan: Boolean(this.scanPromise)
    }).then(() => this.onStateChange?.()).catch(() => {});

    this.stopChangedFileTimer();
    const waitMs = this.store.getState().settings.realtimeDebounceMs || DEFAULT_REALTIME_DEBOUNCE_MS;
    this.changedFileTimer = setTimeout(() => {
      this.flushChangedFiles().catch((error) => {
        this.store.setCapture({ lastError: error.message }).then(() => this.onStateChange?.()).catch(() => {});
      });
    }, waitMs);
  }

  stopChangedFileTimer() {
    if (this.changedFileTimer) {
      clearTimeout(this.changedFileTimer);
      this.changedFileTimer = null;
    }
  }

  async flushChangedFiles() {
    if (this.scanPromise) {
      const waitMs = this.store.getState().settings.realtimeDebounceMs || DEFAULT_REALTIME_DEBOUNCE_MS;
      this.stopChangedFileTimer();
      this.changedFileTimer = setTimeout(() => {
        this.flushChangedFiles().catch(() => {});
      }, waitMs);
      return;
    }

    const queued = [...this.changedFileQueue.values()].slice(0, 100);
    for (const item of queued) {
      this.changedFileQueue.delete(normalizePath(item.filePath));
    }

    await this.store.setCapture({
      pendingFiles: this.changedFileQueue.size,
      pendingRescan: false
    });

    if (!queued.length) {
      this.onStateChange?.();
      return;
    }

    let filesScanned = 0;
    let recordsFound = 0;

    for (const item of queued) {
      const source = this.store.getState().sources.find((candidate) => candidate.id === item.sourceId);
      if (!source?.enabled || !source.exists) {
        continue;
      }

      const result = await this.scanSingleFile(source, item.filePath, { force: false });
      filesScanned += result.filesScanned;
      recordsFound += result.recordsFound;
    }

    const finishedAt = new Date().toISOString();
    await this.store.setScan({
      running: false,
      lastFinishedAt: finishedAt,
      filesScanned,
      recordsFound,
      lastError: null
    });
    await this.store.setCapture({
      mode: "realtime",
      lastParsedAt: finishedAt,
      lastFilesScanned: filesScanned,
      lastRecordsFound: recordsFound,
      pendingFiles: this.changedFileQueue.size,
      pendingRescan: false,
      lastError: null
    });
    await this.store.save();
    this.onStateChange?.();

    if (this.changedFileQueue.size > 0) {
      const waitMs = this.store.getState().settings.realtimeDebounceMs || DEFAULT_REALTIME_DEBOUNCE_MS;
      this.stopChangedFileTimer();
      this.changedFileTimer = setTimeout(() => {
        this.flushChangedFiles().catch(() => {});
      }, waitMs);
    }
  }

  async scanSingleFile(source, filePath, { force = false, fileMeta = null } = {}) {
    if (!isRealtimeFilePath(filePath)) {
      return { filesScanned: 0, recordsFound: 0 };
    }
    if (source.kind === "vscode" && !isAiRelatedPath(filePath)) {
      return { filesScanned: 0, recordsFound: 0 };
    }

    let stats = fileMeta;
    if (!stats) {
      try {
        const fileStats = await fs.stat(filePath);
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

    if (stats.size === 0 || stats.size > 30 * 1024 * 1024) {
      return { filesScanned: 0, recordsFound: 0 };
    }

    const normalizedPath = normalizePath(filePath);
    const previous = this.store.getState().fileIndex[normalizedPath];
    const unchanged = previous && previous.size === stats.size && previous.mtimeMs === stats.mtimeMs;
    if (!force && unchanged) {
      return { filesScanned: 0, recordsFound: previous.recordCount || 0 };
    }

    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return { filesScanned: 0, recordsFound: 0 };
    }

    const records = parseUsageFile({ source, filePath, raw });
    await this.store.replaceRecordsForFile(filePath, records, {
      sourceId: source.id,
      size: stats.size,
      mtimeMs: stats.mtimeMs
    });

    return { filesScanned: 1, recordsFound: records.length };
  }

  async addCustomSource(rootPath) {
    const exists = await pathExists(rootPath);
    if (!exists) {
      return this.getPublicState();
    }

    const customSource = createCustomSource(rootPath);
    const sources = this.store.getState().sources.filter((source) => source.id !== customSource.id);
    sources.push(customSource);
    await this.store.setSources(sources);
    this.start();
    return this.rescan({ force: true });
  }

  async updateSource(sourceId, patch) {
    const allowedPatch = {};
    for (const key of ["enabled", "label", "ide", "provider"]) {
      if (Object.hasOwn(patch || {}, key)) {
        allowedPatch[key] = patch[key];
      }
    }

    const sources = this.store.getState().sources.map((source) => (
      source.id === sourceId ? { ...source, ...allowedPatch } : source
    ));

    await this.store.setSources(sources);
    this.start();
    return this.rescan({ force: false });
  }

  async removeSource(sourceId) {
    const source = this.store.getState().sources.find((item) => item.id === sourceId);
    if (!source?.removable) {
      return this.getPublicState();
    }

    await this.store.removeSource(sourceId);
    this.start();
    return this.getPublicState();
  }

  async exportJson(filePath) {
    const payload = {
      exportedAt: new Date().toISOString(),
      records: this.store.getState().records,
      sources: this.store.getState().sources,
      summary: summarize(this.store.getState().records)
    };

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    await this.store.addExport(filePath);
    return this.getPublicState();
  }
}

function isRealtimeFilePath(filePath) {
  return RELEVANT_REALTIME_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function summarize(records) {
  const summary = {
    recordCount: records.length,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    reportedRecords: 0,
    estimatedRecords: 0,
    runningRecords: 0,
    reportedTokenShare: 0,
    models: [],
    sources: [],
    projects: [],
    daily: []
  };

  const models = new Map();
  const sources = new Map();
  const projects = new Map();
  const daily = new Map();

  for (const record of records) {
    summary.totalTokens += record.totalTokens || 0;
    summary.inputTokens += record.inputTokens || 0;
    summary.outputTokens += record.outputTokens || 0;
    summary.cachedInputTokens += record.cachedInputTokens || record.cacheReadTokens || 0;
    summary.cacheReadTokens += record.cacheReadTokens || record.cachedInputTokens || 0;
    summary.cacheCreationTokens += record.cacheCreationTokens || 0;
    summary.reasoningOutputTokens += record.reasoningOutputTokens || 0;

    if (record.tokenSource === "reported") {
      summary.reportedRecords += 1;
    } else {
      summary.estimatedRecords += 1;
    }
    if (record.status === "running") {
      summary.runningRecords += 1;
    }

    addToGroup(models, record.model || "Unknown model", record);
    addToGroup(sources, record.sourceName || record.sourceId || "Unknown source", record);
    addToGroup(projects, record.projectName || projectNameFromPath(record.projectPath) || "Unknown project", record, record.projectPath || "");

    const day = String(record.timestamp || "").slice(0, 10) || "unknown";
    addToGroup(daily, day, record);
  }

  const reportedTokens = records
    .filter((record) => record.tokenSource === "reported")
    .reduce((total, record) => total + (record.totalTokens || 0), 0);
  summary.reportedTokenShare = summary.totalTokens > 0 ? Math.round((reportedTokens / summary.totalTokens) * 100) : 0;
  summary.models = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.sources = [...sources.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.projects = [...projects.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.daily = [...daily.values()].sort((a, b) => a.name.localeCompare(b.name));

  return summary;
}

function addToGroup(map, name, record, pathValue = "") {
  if (!map.has(name)) {
    map.set(name, {
      name,
      path: pathValue,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningOutputTokens: 0,
      recordCount: 0,
      reportedRecords: 0,
      estimatedRecords: 0,
      runningRecords: 0
    });
  }

  const group = map.get(name);
  if (!group.path && pathValue) {
    group.path = pathValue;
  }
  group.totalTokens += record.totalTokens || 0;
  group.inputTokens += record.inputTokens || 0;
  group.outputTokens += record.outputTokens || 0;
  group.cachedInputTokens += record.cachedInputTokens || record.cacheReadTokens || 0;
  group.cacheReadTokens += record.cacheReadTokens || record.cachedInputTokens || 0;
  group.cacheCreationTokens += record.cacheCreationTokens || 0;
  group.reasoningOutputTokens += record.reasoningOutputTokens || 0;
  group.recordCount += 1;
  if (record.tokenSource === "reported") {
    group.reportedRecords += 1;
  } else {
    group.estimatedRecords += 1;
  }
  if (record.status === "running") {
    group.runningRecords += 1;
  }
}

function buildAnalytics(records) {
  const now = Date.now();
  const recent = records.filter((record) => {
    const timestamp = Date.parse(record.completedAt || record.timestamp || "");
    return Number.isFinite(timestamp) && now - timestamp <= 60_000;
  });
  const latestTimestamp = records.reduce((latest, record) => {
    const timestamp = Date.parse(record.completedAt || record.timestamp || "");
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);

  return {
    requestsPerMinute: recent.length,
    tokensPerMinute: recent.reduce((total, record) => total + (record.totalTokens || 0), 0),
    runningTurns: records.filter((record) => record.status === "running").length,
    latestActivityAt: latestTimestamp ? new Date(latestTimestamp).toISOString() : null
  };
}

function projectNameFromPath(projectPath) {
  if (!projectPath) {
    return "";
  }

  return path.basename(projectPath) || projectPath;
}
