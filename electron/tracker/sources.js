import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const AI_KEYWORDS = [
  "anthropic",
  "claude",
  "codex",
  "openai",
  "gpt",
  "copilot",
  "continue",
  "cline",
  "roo",
  "aider",
  "cursor",
  "windsurf",
  "gemini",
  "ollama"
];

export async function discoverSources(existingSources = []) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [
    {
      id: "codex-sessions",
      label: "Codex sessions",
      kind: "codex",
      ide: "Codex / VS Code",
      provider: "OpenAI",
      rootPath: path.join(home, ".codex", "sessions"),
      confidence: "high",
      removable: false
    },
    {
      id: "codex-home",
      label: "Codex home logs",
      kind: "codex",
      ide: "Codex / VS Code",
      provider: "OpenAI",
      rootPath: path.join(home, ".codex"),
      confidence: "medium",
      removable: false,
      onlyIfMissing: "codex-sessions"
    },
    {
      id: "claude-projects",
      label: "Claude Code projects",
      kind: "claude",
      ide: "Claude Code / VS Code",
      provider: "Anthropic",
      rootPath: path.join(home, ".claude", "projects"),
      confidence: "high",
      removable: false
    },
    {
      id: "claude-home",
      label: "Claude home logs",
      kind: "claude",
      ide: "Claude Code / VS Code",
      provider: "Anthropic",
      rootPath: path.join(home, ".claude"),
      confidence: "medium",
      removable: false,
      onlyIfMissing: "claude-projects"
    },
    {
      id: "vscode-global-storage",
      label: "VS Code AI extension storage",
      kind: "vscode",
      ide: "VS Code",
      provider: "Mixed",
      rootPath: path.join(appData, "Code", "User", "globalStorage"),
      confidence: "medium",
      removable: false
    },
    {
      id: "vscode-logs",
      label: "VS Code logs",
      kind: "vscode",
      ide: "VS Code",
      provider: "Mixed",
      rootPath: path.join(appData, "Code", "logs"),
      confidence: "medium",
      removable: false
    },
    {
      id: "cursor-storage",
      label: "Cursor AI storage",
      kind: "vscode",
      ide: "Cursor",
      provider: "Mixed",
      rootPath: path.join(appData, "Cursor", "User", "globalStorage"),
      confidence: "medium",
      removable: false
    },
    {
      id: "cursor-logs",
      label: "Cursor logs",
      kind: "vscode",
      ide: "Cursor",
      provider: "Mixed",
      rootPath: path.join(appData, "Cursor", "logs"),
      confidence: "medium",
      removable: false
    },
    {
      id: "windsurf-storage",
      label: "Windsurf AI storage",
      kind: "vscode",
      ide: "Windsurf",
      provider: "Mixed",
      rootPath: path.join(appData, "Windsurf", "User", "globalStorage"),
      confidence: "medium",
      removable: false
    },
    {
      id: "continue-home",
      label: "Continue logs",
      kind: "generic",
      ide: "VS Code / JetBrains",
      provider: "Mixed",
      rootPath: path.join(home, ".continue"),
      confidence: "medium",
      removable: false
    },
    {
      id: "ollama-home",
      label: "Ollama metadata",
      kind: "generic",
      ide: "Local model tools",
      provider: "Ollama",
      rootPath: path.join(home, ".ollama"),
      confidence: "low",
      removable: false
    },
    {
      id: "openai-extension-logs",
      label: "OpenAI extension logs",
      kind: "generic",
      ide: "VS Code",
      provider: "OpenAI",
      rootPath: path.join(localAppData, "OpenAI"),
      confidence: "low",
      removable: false
    }
  ];

  const existingById = new Map(existingSources.map((source) => [source.id, source]));
  const existingDetected = new Set();
  const discovered = [];

  for (const candidate of candidates) {
    if (candidate.onlyIfMissing && existingDetected.has(candidate.onlyIfMissing)) {
      continue;
    }

    const exists = await pathExists(candidate.rootPath);
    if (!exists) {
      continue;
    }

    existingDetected.add(candidate.id);
    const previous = existingById.get(candidate.id);
    discovered.push({
      ...candidate,
      enabled: previous?.enabled ?? true,
      custom: false,
      exists: true,
      status: "ready",
      lastScanAt: previous?.lastScanAt || null,
      createdAt: previous?.createdAt || new Date().toISOString()
    });
  }

  const customSources = existingSources.filter((source) => source.custom);
  const unavailablePinned = existingSources
    .filter((source) => !source.custom && !discovered.some((item) => item.id === source.id))
    .map((source) => ({
      ...source,
      exists: false,
      enabled: false,
      status: "missing"
    }));

  return [...discovered, ...customSources, ...unavailablePinned];
}

export function createCustomSource(rootPath) {
  const idHash = crypto.createHash("sha1").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 10);

  return {
    id: `custom-${idHash}`,
    label: path.basename(rootPath) || "Custom log folder",
    kind: "generic",
    ide: "Custom IDE",
    provider: "Mixed",
    rootPath,
    confidence: "manual",
    removable: true,
    custom: true,
    enabled: true,
    exists: true,
    status: "ready",
    createdAt: new Date().toISOString(),
    lastScanAt: null
  };
}

export function isAiRelatedPath(filePath) {
  const lowerPath = filePath.toLowerCase();
  return AI_KEYWORDS.some((keyword) => lowerPath.includes(keyword));
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
