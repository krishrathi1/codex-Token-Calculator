const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const RELEVANT_EXTENSIONS = new Set([".jsonl"]);
const IGNORED_DIRS = new Set([".git", "cache", "cacheddata", "code cache", "gpucache", "node_modules", "crashpad", "blob_storage"]);
const TOKENISH_SYMBOLS = /[{}[\]();.,:+\-*/<>=_|`$#@!~%^&?\\]/g;
const MODEL_HINTS = [/gpt[-_\s.]?[0-9a-z.:-]+/i, /o[1-9][-_a-z0-9.]*/i];

async function discoverSources(existingSources = [], configuredPaths = []) {
  const home = os.homedir();
  const candidates = [
    sourceCandidate("codex-sessions", "Codex sessions", path.join(home, ".codex", "sessions"), "high")
  ];

  const existingById = new Map(existingSources.map((source) => [source.id, source]));
  const detected = [];

  for (const candidate of candidates) {
    if (!(await pathExists(candidate.rootPath))) {
      continue;
    }

    const previous = existingById.get(candidate.id);
    detected.push({
      ...candidate,
      enabled: previous?.enabled ?? true,
      exists: true,
      status: "ready",
      custom: false,
      removable: false,
      lastScanAt: previous?.lastScanAt || null,
      createdAt: previous?.createdAt || new Date().toISOString()
    });
  }

  const manualSources = [];
  const seenManual = new Set();
  for (const source of existingSources.filter((item) => item.custom)) {
    const exists = await pathExists(source.rootPath);
    manualSources.push({
      ...source,
      kind: "codex",
      ide: "Codex",
      provider: "OpenAI",
      exists,
      status: exists ? "ready" : "missing"
    });
    seenManual.add(normalizePath(source.rootPath));
  }

  for (const configuredPath of configuredPaths.filter(Boolean)) {
    const resolved = path.resolve(String(configuredPath));
    const normalized = normalizePath(resolved);
    if (seenManual.has(normalized)) {
      continue;
    }
    if (await pathExists(resolved)) {
      manualSources.push(createCustomSource(resolved));
      seenManual.add(normalized);
    }
  }

  return [...detected, ...manualSources];
}

function sourceCandidate(id, label, rootPath, confidence) {
  return {
    id,
    label,
    kind: "codex",
    ide: "Codex",
    provider: "OpenAI",
    rootPath,
    confidence
  };
}

function createCustomSource(rootPath) {
  const idHash = crypto.createHash("sha1").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 10);
  return {
    id: `custom-${idHash}`,
    label: path.basename(rootPath) || "Custom Codex folder",
    kind: "codex",
    ide: "Codex",
    provider: "OpenAI",
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

async function collectRelevantFiles(source, options = {}) {
  const files = [];
  const rootPath = path.resolve(source.rootPath);
  const maxFiles = options.maxFiles || 1000;
  const maxDepth = options.maxDepth || 9;
  const maxFileSize = options.maxFileSize || 30 * 1024 * 1024;

  await walk(rootPath, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);

  async function walk(currentPath, depth) {
    if (files.length >= maxFiles || depth > maxDepth) {
      return;
    }

    let entries;
    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }

      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name.toLowerCase())) {
          await walk(entryPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile() || !isCodexLogPath(entryPath)) {
        continue;
      }

      let stats;
      try {
        stats = await fsp.stat(entryPath);
      } catch {
        continue;
      }

      if (stats.size === 0 || stats.size > maxFileSize) {
        continue;
      }

      files.push({ filePath: entryPath, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }
}

function parseUsageFile({ source, filePath, raw }) {
  return parseCodexUsageFile({ source, filePath, raw });
}

function parseCodexUsageFile({ source, filePath, raw }) {
  const records = [];
  const lines = raw.split(/\r?\n/u);
  let activeTurn = null;
  let currentModel = "Codex model";
  let sessionId = null;
  let sessionCwd = "";
  let sessionWorkspaceRoots = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || !looksLikeJson(line)) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = event.payload || {};
    const payloadType = payload.type;
    const lineNumber = index + 1;

    if (event.type === "session_meta") {
      sessionId = payload.id || sessionId;
      sessionCwd = payload.cwd || sessionCwd;
      sessionWorkspaceRoots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : sessionWorkspaceRoots;
      currentModel = payload.model || currentModel;
      continue;
    }

    if (event.type === "event_msg" && payloadType === "task_started") {
      finalizeActive("interrupted");
      activeTurn = createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp: event.timestamp, turnId: payload.turn_id, model: currentModel });
      continue;
    }

    if (event.type === "turn_context") {
      if (activeTurn && payload.turn_id && activeTurn.turnId && activeTurn.turnId !== payload.turn_id) {
        finalizeActive("interrupted");
      }
      if (!activeTurn) {
        activeTurn = createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp: event.timestamp, turnId: payload.turn_id, model: currentModel });
      }
      activeTurn.turnId = payload.turn_id || activeTurn.turnId;
      activeTurn.model = payload.model || activeTurn.model || currentModel;
      activeTurn.projectPath = payload.cwd || activeTurn.projectPath || sessionCwd;
      activeTurn.workspaceRoots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : activeTurn.workspaceRoots;
      currentModel = activeTurn.model;
      continue;
    }

    if (event.type === "event_msg" && payloadType === "user_message") {
      if (activeTurn?.prompt || activeTurn?.assistantMessages.length || activeTurn?.usageCount > 0) {
        finalizeActive("completed");
      }
      if (!activeTurn) {
        activeTurn = createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp: event.timestamp, turnId: payload.turn_id, model: currentModel });
      }
      activeTurn.prompt = typeof payload.message === "string" ? payload.message : "";
      activeTurn.timestamp = event.timestamp || activeTurn.timestamp;
      activeTurn.lineNumber = Math.min(activeTurn.lineNumber, lineNumber);
      continue;
    }

    if (event.type === "event_msg" && payloadType === "agent_message") {
      if (!activeTurn) {
        activeTurn = createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp: event.timestamp, turnId: payload.turn_id, model: currentModel });
      }
      if (typeof payload.message === "string" && payload.message.trim()) {
        activeTurn.assistantMessages.push(payload.message.trim());
      }
      activeTurn.lastActivityAt = event.timestamp || activeTurn.lastActivityAt;
      continue;
    }

    if (event.type === "response_item" && payloadType === "message" && payload.role === "assistant") {
      if (!activeTurn) {
        activeTurn = createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp: event.timestamp, turnId: payload.turn_id, model: currentModel });
      }
      const fallbackText = contentToText(payload.content);
      if (fallbackText) {
        activeTurn.assistantFallbacks.push(fallbackText);
      }
      activeTurn.lastActivityAt = event.timestamp || activeTurn.lastActivityAt;
      continue;
    }

    if (event.type === "event_msg" && payloadType === "token_count") {
      if (!activeTurn) {
        activeTurn = createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp: event.timestamp, turnId: payload.turn_id, model: currentModel });
      }
      const usage = normalizeCodexUsage(payload.info?.last_token_usage);
      if (usage) {
        addUsage(activeTurn, usage);
      }
      activeTurn.lastActivityAt = event.timestamp || activeTurn.lastActivityAt;
      continue;
    }

    if (event.type === "event_msg" && (payloadType === "task_complete" || payloadType === "turn_aborted")) {
      if (activeTurn) {
        activeTurn.completedAt = payload.completed_at || event.timestamp || activeTurn.lastActivityAt;
        finalizeActive(payloadType === "task_complete" ? "completed" : "aborted");
      }
    }
  }

  finalizeActive("running");
  return dedupeRecords(records);

  function finalizeActive(status) {
    if (!activeTurn || !activeHasData(activeTurn)) {
      activeTurn = null;
      return;
    }

    records.push(activeTurnToRecord(activeTurn, status));
    activeTurn = null;
  }
}

function createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp, turnId, model }) {
  const projectPath = sessionCwd || firstWorkspaceRoot(sessionWorkspaceRoots) || "";
  return {
    source,
    filePath,
    sessionId,
    projectPath,
    workspaceRoots: Array.isArray(sessionWorkspaceRoots) ? sessionWorkspaceRoots : [],
    lineNumber,
    timestamp,
    completedAt: null,
    lastActivityAt: timestamp,
    turnId,
    model,
    prompt: "",
    assistantMessages: [],
    assistantFallbacks: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0
    },
    usageCount: 0
  };
}

function contentToText(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join("\n").trim();
  }
  if (typeof value !== "object") {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text.trim();
  }
  if (value.content) {
    return contentToText(value.content);
  }
  return "";
}

function normalizeCodexUsage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const inputTokens = numberFromKeys(value, ["input_tokens", "inputTokens"]);
  const outputTokens = numberFromKeys(value, ["output_tokens", "outputTokens"]);
  const totalTokens = numberFromKeys(value, ["total_tokens", "totalTokens"]);
  const cachedInputTokens = numberFromKeys(value, ["cached_input_tokens", "cachedInputTokens"]);
  const reasoningOutputTokens = numberFromKeys(value, ["reasoning_output_tokens", "reasoningOutputTokens"]);

  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return null;
  }

  return {
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    totalTokens: totalTokens || (inputTokens || 0) + (outputTokens || 0),
    cachedInputTokens: cachedInputTokens || 0,
    reasoningOutputTokens: reasoningOutputTokens || 0
  };
}

function addUsage(turn, usage) {
  turn.usage.inputTokens += usage.inputTokens || 0;
  turn.usage.outputTokens += usage.outputTokens || 0;
  turn.usage.totalTokens += usage.totalTokens || 0;
  turn.usage.cachedInputTokens += usage.cachedInputTokens || 0;
  turn.usage.reasoningOutputTokens += usage.reasoningOutputTokens || 0;
  turn.usageCount += 1;
}

function activeHasData(turn) {
  return Boolean(turn.prompt || turn.assistantMessages.length || turn.assistantFallbacks.length || turn.usageCount > 0);
}

function activeTurnToRecord(turn, status) {
  const output = (turn.assistantMessages.length ? turn.assistantMessages : turn.assistantFallbacks).join("\n\n").trim();
  const measuredUsage = turn.usageCount > 0 ? { ...turn.usage, tokenSource: "reported" } : estimateUsage(turn.prompt, output);
  const stableMaterial = [turn.source.id, turn.filePath, turn.sessionId, turn.turnId || turn.lineNumber].join("|");

  return {
    id: crypto.createHash("sha1").update(stableMaterial).digest("hex"),
    sourceId: turn.source.id,
    sourceName: turn.source.label,
    sourceKind: turn.source.kind,
    ide: turn.source.ide,
    provider: turn.source.provider,
    model: turn.model || inferModel({ text: `${turn.prompt}\n${output}` }),
    projectPath: turn.projectPath || "",
    projectName: projectNameFromPath(turn.projectPath),
    workspaceRoots: turn.workspaceRoots || [],
    prompt: turn.prompt,
    output,
    inputTokens: measuredUsage.inputTokens || 0,
    outputTokens: measuredUsage.outputTokens || 0,
    totalTokens: measuredUsage.totalTokens || 0,
    cachedInputTokens: measuredUsage.cachedInputTokens || 0,
    reasoningOutputTokens: measuredUsage.reasoningOutputTokens || 0,
    cacheReadTokens: measuredUsage.cachedInputTokens || 0,
    cacheCreationTokens: 0,
    tokenSource: measuredUsage.tokenSource || "estimated",
    status,
    timestamp: normalizeTimestamp(turn.timestamp || turn.lastActivityAt),
    completedAt: turn.completedAt ? normalizeTimestamp(turn.completedAt) : null,
    filePath: turn.filePath,
    lineNumber: turn.lineNumber,
    conversationId: turn.sessionId,
    requestId: turn.turnId
  };
}

function summarizeRecords(records) {
  const summary = {
    recordCount: records.length,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    reportedRecords: 0,
    estimatedRecords: 0,
    reportedTokenShare: 0,
    models: [],
    sources: [],
    projects: [],
    days: []
  };
  const models = new Map();
  const sources = new Map();
  const projects = new Map();
  const days = new Map();

  for (const record of records) {
    summary.totalTokens += record.totalTokens || 0;
    summary.inputTokens += record.inputTokens || 0;
    summary.outputTokens += record.outputTokens || 0;
    summary.cachedInputTokens += record.cachedInputTokens || 0;
    summary.reasoningOutputTokens += record.reasoningOutputTokens || 0;
    if (record.tokenSource === "reported") {
      summary.reportedRecords += 1;
    } else {
      summary.estimatedRecords += 1;
    }

    addToGroup(models, record.model || "Codex model", record);
    addToGroup(sources, record.sourceName || "Codex", record);
    addToGroup(projects, record.projectName || record.projectPath || "Unknown project", record, record.projectPath);
    addToGroup(days, String(record.timestamp || "").slice(0, 10) || "unknown", record);
  }

  const reportedTokens = [...models.values()].reduce((total, item) => total + item.reportedTokens, 0);
  summary.reportedTokenShare = summary.totalTokens > 0 ? Math.round((reportedTokens / summary.totalTokens) * 100) : 0;
  summary.models = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.sources = [...sources.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.projects = [...projects.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.days = [...days.values()].sort((a, b) => a.name.localeCompare(b.name));
  return summary;
}

function buildGraph(records) {
  const nodes = new Map();
  const edges = new Map();

  ensureNode(nodes, "root", "Codex Usage", "root", 0);

  for (const record of records) {
    const sourceId = `source:${record.sourceId}`;
    const modelId = `model:${record.model || "Codex model"}`;
    const projectId = `project:${record.projectPath || record.projectName || "Unknown project"}`;
    const dayId = `day:${String(record.timestamp || "").slice(0, 10) || "unknown"}`;
    ensureNode(nodes, sourceId, record.sourceName || "Codex", "source", record.totalTokens);
    ensureNode(nodes, modelId, record.model || "Codex model", "model", record.totalTokens);
    ensureNode(nodes, projectId, record.projectName || record.projectPath || "Unknown project", "project", record.totalTokens);
    ensureNode(nodes, dayId, String(record.timestamp || "").slice(0, 10) || "unknown", "day", record.totalTokens);
    addEdge(edges, "root", sourceId, record.totalTokens, record);
    addEdge(edges, sourceId, modelId, record.totalTokens, record);
    addEdge(edges, modelId, projectId, record.totalTokens, record);
    addEdge(edges, projectId, dayId, record.totalTokens, record);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].sort((a, b) => b.tokens - a.tokens)
  };
}

function ensureNode(map, id, label, type, tokens) {
  if (!map.has(id)) {
    map.set(id, { id, label, type, tokens: 0, records: 0 });
  }
  const node = map.get(id);
  node.tokens += tokens || 0;
  if (type !== "root") {
    node.records += 1;
  }
}

function addEdge(map, from, to, tokens, record) {
  const id = `${from}->${to}`;
  if (!map.has(id)) {
    map.set(id, { id, from, to, tokens: 0, records: 0, reportedRecords: 0, estimatedRecords: 0 });
  }
  const edge = map.get(id);
  edge.tokens += tokens || 0;
  edge.records += 1;
  if (record.tokenSource === "reported") {
    edge.reportedRecords += 1;
  } else {
    edge.estimatedRecords += 1;
  }
}

function estimateTokens(text = "") {
  if (!text || typeof text !== "string") {
    return 0;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  const wordCount = trimmed.split(/\s+/u).filter(Boolean).length;
  const symbolCount = (trimmed.match(TOKENISH_SYMBOLS) || []).length;
  return Math.max(1, Math.ceil(Math.max(trimmed.length / 4, wordCount * 1.25) + symbolCount * 0.15));
}

function estimateUsage(prompt = "", output = "") {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(output);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: 0, reasoningOutputTokens: 0, tokenSource: "estimated" };
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
      reasoningOutputTokens: 0,
      recordCount: 0,
      reportedRecords: 0,
      estimatedRecords: 0,
      reportedTokens: 0
    });
  }
  const group = map.get(name);
  if (!group.path && pathValue) {
    group.path = pathValue;
  }
  group.totalTokens += record.totalTokens || 0;
  group.inputTokens += record.inputTokens || 0;
  group.outputTokens += record.outputTokens || 0;
  group.cachedInputTokens += record.cachedInputTokens || 0;
  group.reasoningOutputTokens += record.reasoningOutputTokens || 0;
  group.recordCount += 1;
  if (record.tokenSource === "reported") {
    group.reportedRecords += 1;
    group.reportedTokens += record.totalTokens || 0;
  } else {
    group.estimatedRecords += 1;
  }
}

function firstWorkspaceRoot(roots) {
  return Array.isArray(roots) && roots.length > 0 ? roots[0] : "";
}

function projectNameFromPath(projectPath) {
  if (!projectPath) {
    return "Unknown project";
  }
  return path.basename(projectPath) || projectPath;
}

function inferModel({ text = "" }) {
  for (const hint of MODEL_HINTS) {
    const match = text.match(hint);
    if (match?.[0]) {
      return cleanModelName(match[0]);
    }
  }
  return "Codex model";
}

function cleanModelName(value) {
  return String(value).replace(/^model[:=\s]+/iu, "").trim();
}

function numberFromKeys(value, keys) {
  for (const key of keys) {
    if (value[key] == null) {
      continue;
    }
    const number = Number(value[key]);
    if (Number.isFinite(number)) {
      return Math.max(0, Math.round(number));
    }
  }
  return null;
}

function dedupeRecords(records) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    if (!seen.has(record.id)) {
      seen.add(record.id);
      unique.push(record);
    }
  }
  return unique;
}

function normalizeTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 10000000000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function looksLikeJson(value) {
  return value.startsWith("{") || value.startsWith("[");
}

function isCodexLogPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!RELEVANT_EXTENSIONS.has(extension)) {
    return false;
  }
  const name = path.basename(filePath).toLowerCase();
  return name.startsWith("rollout-") || name.includes("codex") || name.endsWith(".jsonl");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}

module.exports = {
  buildGraph,
  collectRelevantFiles,
  createCustomSource,
  discoverSources,
  estimateUsage,
  isCodexLogPath,
  normalizePath,
  parseUsageFile,
  pathExists,
  summarizeRecords
};
