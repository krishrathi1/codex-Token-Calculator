import fs from "node:fs/promises";
import path from "node:path";
import { isAiRelatedPath } from "./sources.js";

const RELEVANT_EXTENSIONS = new Set([".jsonl", ".ndjson", ".json", ".log", ".txt"]);
const IGNORED_DIRS = new Set([
  ".git",
  "cache",
  "cacheddata",
  "code cache",
  "gpucache",
  "node_modules",
  "crashpad",
  "blob_storage"
]);

const MAX_FILES_PER_SOURCE = 2_000;
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_DEPTH = 9;

export async function collectRelevantFiles(source) {
  const files = [];
  const rootPath = path.resolve(source.rootPath);

  await walk(rootPath, 0);

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_PER_SOURCE);

  async function walk(currentPath, depth) {
    if (files.length >= MAX_FILES_PER_SOURCE || depth > MAX_DEPTH) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_SOURCE) {
        break;
      }

      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) {
          continue;
        }
        await walk(entryPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!RELEVANT_EXTENSIONS.has(extension)) {
        continue;
      }

      if (source.kind === "vscode" && !isAiRelatedPath(entryPath)) {
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(entryPath);
      } catch {
        continue;
      }

      if (stats.size === 0 || stats.size > MAX_FILE_SIZE) {
        continue;
      }

      files.push({
        filePath: entryPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs
      });
    }
  }
}
