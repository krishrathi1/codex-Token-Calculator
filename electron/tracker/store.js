import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  createdAt: null,
  updatedAt: null,
  settings: {
    scanIntervalMs: 10_000,
    realtimeDebounceMs: 500
  },
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
    mode: "realtime",
    lastEventAt: null,
    lastParsedAt: null,
    pendingFiles: 0,
    pendingRescan: false,
    lastFilesScanned: 0,
    lastRecordsFound: 0,
    lastError: null
  },
  exports: []
};

export class TrackerStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(DEFAULT_STATE);
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        ...structuredClone(DEFAULT_STATE),
        ...parsed,
        settings: {
          ...DEFAULT_STATE.settings,
          ...(parsed.settings || {})
        },
        scan: {
          ...DEFAULT_STATE.scan,
          ...(parsed.scan || {})
        },
        capture: {
          ...DEFAULT_STATE.capture,
          ...(parsed.capture || {})
        }
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      const now = new Date().toISOString();
      this.state.createdAt = now;
      this.state.updatedAt = now;
      await this.save();
    }
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  getState() {
    return this.state;
  }

  async setSources(sources) {
    this.state.sources = sources;
    await this.save();
  }

  async setScan(patch) {
    this.state.scan = {
      ...this.state.scan,
      ...patch
    };
    await this.save();
  }

  async setCapture(patch) {
    this.state.capture = {
      ...this.state.capture,
      ...patch
    };
    await this.save();
  }

  async replaceRecordsForFile(filePath, records, fileMeta) {
    const normalizedPath = normalizePath(filePath);
    this.state.records = [
      ...this.state.records.filter((record) => normalizePath(record.filePath) !== normalizedPath),
      ...records
    ].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    this.state.fileIndex[normalizedPath] = {
      ...fileMeta,
      scannedAt: new Date().toISOString(),
      recordCount: records.length
    };
  }

  async removeSource(sourceId) {
    this.state.sources = this.state.sources.filter((source) => source.id !== sourceId);
    this.state.records = this.state.records.filter((record) => record.sourceId !== sourceId);

    for (const [filePath, meta] of Object.entries(this.state.fileIndex)) {
      if (meta.sourceId === sourceId) {
        delete this.state.fileIndex[filePath];
      }
    }

    await this.save();
  }

  async addExport(filePath) {
    this.state.exports = [
      {
        filePath,
        exportedAt: new Date().toISOString(),
        recordCount: this.state.records.length
      },
      ...this.state.exports
    ].slice(0, 10);

    await this.save();
  }
}

export function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}
