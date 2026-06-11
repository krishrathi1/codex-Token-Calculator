import crypto from "node:crypto";
import path from "node:path";
import { estimateUsage } from "./tokenizer.js";

const MODEL_HINTS = [
  /claude[-_\s.](opus|sonnet|haiku|instant)[-_\s.]?[0-9a-z.:-]*/i,
  /gpt[-_\s.]?[0-9a-z.:-]+/i,
  /o[1-9][-_a-z0-9.]*/i,
  /gemini[-_\s.]?[0-9a-z.:-]+/i,
  /llama[-_\s.]?[0-9a-z.:-]+/i,
  /mistral[-_\s.]?[0-9a-z.:-]+/i,
  /deepseek[-_\s.]?[0-9a-z.:-]+/i,
  /qwen[-_\s.]?[0-9a-z.:-]+/i
];

const USER_TYPES = new Set(["user", "human", "user_message", "prompt", "input"]);
const ASSISTANT_TYPES = new Set([
  "assistant",
  "ai",
  "assistant_message",
  "model",
  "model_response",
  "response",
  "output",
  "completion"
]);

export function parseUsageFile({ source, filePath, raw }) {
  const extension = path.extname(filePath).toLowerCase();
  const parsedItems = extension === ".json" ? parseJsonDocument(raw) : parseJsonLines(raw);

  if (parsedItems.length > 0) {
    return parseStructuredItems({ source, filePath, items: parsedItems });
  }

  return parseTextLog({ source, filePath, raw });
}

function parseJsonLines(raw) {
  const items = [];
  const lines = raw.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || !looksLikeJson(line)) {
      continue;
    }

    try {
      items.push({
        value: JSON.parse(line),
        lineNumber: index + 1
      });
    } catch {
      // Some IDE logs mix text and JSON. The text fallback will handle those.
    }
  }

  return items;
}

function parseJsonDocument(raw) {
  if (!looksLikeJson(raw.trim())) {
    return [];
  }

  try {
    const value = JSON.parse(raw);
    const values = Array.isArray(value) ? value : flattenLikelyMessageArrays(value);
    return values.map((item, index) => ({
      value: item,
      lineNumber: index + 1
    }));
  } catch {
    return [];
  }
}

function parseStructuredItems({ source, filePath, items }) {
  if (items.some((item) => isCodexSessionEvent(item.value))) {
    return parseCodexStructuredItems({ source, filePath, items });
  }

  const records = [];
  let currentPrompt = null;
  let currentModel = null;
  let pendingUsage = null;
  let lastRecord = null;
  let conversationId = null;

  for (const item of items) {
    const event = normalizeEvent(item.value, source, filePath);
    if (!event) {
      continue;
    }

    if (event.conversationId) {
      conversationId = event.conversationId;
    }

    if (event.model) {
      currentModel = event.model;
    }

    if (event.usage) {
      if (lastRecord && !lastRecord.hasReportedUsage) {
        applyUsage(lastRecord, event.usage);
      } else {
        pendingUsage = event.usage;
      }
    }

    if (event.role === "user" && event.text) {
      currentPrompt = {
        text: event.text,
        timestamp: event.timestamp,
        lineNumber: item.lineNumber,
        conversationId: event.conversationId || conversationId,
        requestId: event.requestId
      };
      continue;
    }

    if (event.role === "assistant" && event.text) {
      const prompt = currentPrompt?.text || "";
      const usage = event.usage || pendingUsage;
      const model = event.model || currentModel || inferModel({ source, filePath, text: event.text });
      const record = createRecord({
        source,
        filePath,
        lineNumber: item.lineNumber,
        timestamp: event.timestamp || currentPrompt?.timestamp,
        conversationId: event.conversationId || currentPrompt?.conversationId || conversationId,
        requestId: event.requestId || currentPrompt?.requestId,
        model,
        prompt,
        output: event.text,
        usage
      });

      records.push(record);
      lastRecord = record;
      pendingUsage = null;
      currentPrompt = null;
      continue;
    }

    if (event.role === "assistant" && event.usage && currentPrompt?.text) {
      const record = createRecord({
        source,
        filePath,
        lineNumber: item.lineNumber,
        timestamp: event.timestamp || currentPrompt.timestamp,
        conversationId: event.conversationId || currentPrompt.conversationId || conversationId,
        requestId: event.requestId || currentPrompt.requestId,
        model: event.model || currentModel || inferModel({ source, filePath, text: currentPrompt.text }),
        prompt: currentPrompt.text,
        output: "",
        usage: event.usage
      });

      records.push(record);
      lastRecord = record;
      pendingUsage = null;
      currentPrompt = null;
    }
  }

  return dedupeRecords(records);
}

function parseCodexStructuredItems({ source, filePath, items }) {
  const records = [];
  let activeTurn = null;
  let currentModel = "Codex model";
  let sessionId = null;
  let sessionCwd = "";
  let sessionWorkspaceRoots = [];

  for (const item of items) {
    const event = item.value;
    const payload = event?.payload || {};
    const payloadType = payload.type;
    const lineNumber = item.lineNumber;

    if (event.type === "session_meta") {
      sessionId = payload.id || sessionId;
      sessionCwd = payload.cwd || sessionCwd;
      sessionWorkspaceRoots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : sessionWorkspaceRoots;
      currentModel = payload.model || currentModel;
      continue;
    }

    if (event.type === "event_msg" && payloadType === "task_started") {
      finalizeActive("interrupted");
      activeTurn = createActiveTurn({
        source,
        filePath,
        sessionId,
        sessionCwd,
        sessionWorkspaceRoots,
        lineNumber,
        timestamp: event.timestamp,
        turnId: payload.turn_id,
        model: currentModel
      });
      continue;
    }

    if (event.type === "turn_context") {
      if (activeTurn && payload.turn_id && activeTurn.turnId && activeTurn.turnId !== payload.turn_id) {
        finalizeActive("interrupted");
      }
      if (!activeTurn) {
        activeTurn = createActiveTurn({
          source,
          filePath,
          sessionId,
          sessionCwd,
          sessionWorkspaceRoots,
          lineNumber,
          timestamp: event.timestamp,
          turnId: payload.turn_id,
          model: currentModel
        });
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
        activeTurn = createActiveTurn({
          source,
          filePath,
          sessionId,
          sessionCwd,
          sessionWorkspaceRoots,
          lineNumber,
          timestamp: event.timestamp,
          turnId: payload.turn_id,
          model: currentModel
        });
      }
      activeTurn.prompt = typeof payload.message === "string" ? payload.message : "";
      activeTurn.timestamp = event.timestamp || activeTurn.timestamp;
      activeTurn.lineNumber = Math.min(activeTurn.lineNumber, lineNumber);
      continue;
    }

    if (event.type === "event_msg" && payloadType === "agent_message") {
      if (!activeTurn) {
        activeTurn = createActiveTurn({
          source,
          filePath,
          sessionId,
          sessionCwd,
          sessionWorkspaceRoots,
          lineNumber,
          timestamp: event.timestamp,
          turnId: payload.turn_id,
          model: currentModel
        });
      }
      if (typeof payload.message === "string" && payload.message.trim()) {
        activeTurn.assistantMessages.push(payload.message.trim());
      }
      activeTurn.lastActivityAt = event.timestamp || activeTurn.lastActivityAt;
      continue;
    }

    if (event.type === "response_item" && payloadType === "message" && payload.role === "assistant") {
      if (!activeTurn) {
        activeTurn = createActiveTurn({
          source,
          filePath,
          sessionId,
          sessionCwd,
          sessionWorkspaceRoots,
          lineNumber,
          timestamp: event.timestamp,
          turnId: payload.turn_id,
          model: currentModel
        });
      }
      const fallbackText = contentToText(payload.content, "assistant");
      if (fallbackText) {
        activeTurn.assistantFallbacks.push(fallbackText);
      }
      activeTurn.lastActivityAt = event.timestamp || activeTurn.lastActivityAt;
      continue;
    }

    if (event.type === "event_msg" && payloadType === "token_count") {
      if (!activeTurn) {
        activeTurn = createActiveTurn({
          source,
          filePath,
          sessionId,
          sessionCwd,
          sessionWorkspaceRoots,
          lineNumber,
          timestamp: event.timestamp,
          turnId: payload.turn_id,
          model: currentModel
        });
      }
      const usage = normalizeUsage(payload.info?.last_token_usage || payload.info?.usage || payload.info);
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

function isCodexSessionEvent(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return value.type === "session_meta"
    || value.type === "turn_context"
    || (value.type === "event_msg" && ["task_started", "user_message", "agent_message", "token_count", "task_complete", "turn_aborted"].includes(value.payload?.type));
}

function createActiveTurn({ source, filePath, sessionId, sessionCwd, sessionWorkspaceRoots, lineNumber, timestamp, turnId, model }) {
  const projectPath = sessionCwd || firstWorkspaceRoot(sessionWorkspaceRoots) || "";
  return {
    source,
    filePath,
    sessionId,
    projectPath,
    projectName: projectNameFromPath(projectPath),
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
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningOutputTokens: 0,
      tokenSource: "reported"
    },
    usageCount: 0
  };
}

function activeHasData(turn) {
  return Boolean(turn.prompt || turn.assistantMessages.length || turn.assistantFallbacks.length || turn.usageCount > 0);
}

function activeTurnToRecord(turn, status) {
  const output = (turn.assistantMessages.length ? turn.assistantMessages : turn.assistantFallbacks).join("\n\n").trim();
  const usage = turn.usageCount > 0 ? { ...turn.usage, tokenSource: "reported" } : null;

  return createRecord({
    source: turn.source,
    filePath: turn.filePath,
    lineNumber: turn.lineNumber,
    timestamp: turn.timestamp || turn.lastActivityAt,
    completedAt: turn.completedAt,
    conversationId: turn.sessionId,
    requestId: turn.turnId,
    model: turn.model,
    prompt: turn.prompt,
    output,
    usage,
    status,
    projectPath: turn.projectPath,
    projectName: turn.projectName,
    workspaceRoots: turn.workspaceRoots
  });
}

function addUsage(turn, usage) {
  turn.usage.inputTokens += usage.inputTokens || 0;
  turn.usage.outputTokens += usage.outputTokens || 0;
  turn.usage.totalTokens += usage.totalTokens || 0;
  turn.usage.cachedInputTokens += usage.cachedInputTokens || usage.cacheReadTokens || 0;
  turn.usage.cacheReadTokens += usage.cacheReadTokens || usage.cachedInputTokens || 0;
  turn.usage.cacheCreationTokens += usage.cacheCreationTokens || 0;
  turn.usage.reasoningOutputTokens += usage.reasoningOutputTokens || 0;
  turn.usageCount += 1;
}

function parseTextLog({ source, filePath, raw }) {
  const records = [];
  const blocks = raw.split(/\n(?=(?:user|human|prompt|assistant|model|output|response)\s*[:>])/iu);
  let currentPrompt = "";

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }

    const lower = trimmed.slice(0, 40).toLowerCase();
    if (/^(user|human|prompt)\s*[:>]/u.test(lower)) {
      currentPrompt = trimmed.replace(/^(user|human|prompt)\s*[:>]\s*/iu, "").trim();
      continue;
    }

    if (/^(assistant|model|output|response)\s*[:>]/u.test(lower) && currentPrompt) {
      const output = trimmed.replace(/^(assistant|model|output|response)\s*[:>]\s*/iu, "").trim();
      records.push(
        createRecord({
          source,
          filePath,
          lineNumber: 1,
          timestamp: null,
          conversationId: null,
          requestId: null,
          model: inferModel({ source, filePath, text: `${currentPrompt}\n${output}` }),
          prompt: currentPrompt,
          output,
          usage: null
        })
      );
      currentPrompt = "";
    }
  }

  return dedupeRecords(records);
}

function normalizeEvent(value, source, filePath) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const role = detectRole(value);
  const text = role ? extractTextForRole(value, role) : "";
  const usage = normalizeUsage(value);
  const model = findModel(value);

  if (!role && !usage && !model) {
    return null;
  }

  return {
    role,
    text,
    usage,
    model,
    timestamp: findFirstString(value, ["timestamp", "createdAt", "created_at", "time", "date"]),
    conversationId: findFirstString(value, ["sessionId", "session_id", "conversationId", "conversation_id", "chatId", "chat_id"]),
    requestId: findFirstString(value, ["requestId", "request_id", "turnId", "turn_id", "uuid", "id"])
  };
}

function detectRole(value) {
  const directRole = String(value.role || value.type || value.kind || "").toLowerCase();
  const nestedRole = String(value.message?.role || value.payload?.role || value.payload?.message?.role || "").toLowerCase();
  const payloadType = String(value.payload?.type || value.payload?.event || value.event || "").toLowerCase();
  const itemRole = String(value.item?.role || value.payload?.item?.role || value.response?.role || "").toLowerCase();

  for (const candidate of [nestedRole, itemRole, directRole, payloadType]) {
    const normalized = candidate.replace(/[^a-z_]/gu, "_");
    if (USER_TYPES.has(normalized)) {
      return "user";
    }
    if (ASSISTANT_TYPES.has(normalized)) {
      return "assistant";
    }
  }

  if (value.type === "response_item" || value.type === "event_msg") {
    const text = JSON.stringify(value).toLowerCase();
    if (text.includes('"role":"assistant"') || text.includes('"output_text"')) {
      return "assistant";
    }
    if (text.includes('"role":"user"') || text.includes('"input_text"')) {
      return "user";
    }
  }

  return null;
}

function extractTextForRole(value, role) {
  const directCandidates = [
    value.message,
    value.payload?.message,
    value.payload?.item,
    value.item,
    value.response,
    value.completion,
    value.text,
    value.content,
    value.prompt,
    value.output
  ];

  for (const candidate of directCandidates) {
    const text = contentToText(candidate, role);
    if (text) {
      return text;
    }
  }

  const recursive = findRoleText(value, role);
  return recursive || "";
}

function contentToText(value, role) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => contentToText(item, role)).filter(Boolean).join("\n").trim();
  }

  if (typeof value !== "object") {
    return "";
  }

  const type = String(value.type || "").toLowerCase();
  if (type.includes("tool") || type.includes("thinking") || type.includes("reasoning")) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text.trim();
  }
  if (typeof value.value === "string") {
    return value.value.trim();
  }
  if (typeof value.message === "string") {
    return value.message.trim();
  }
  if (typeof value.prompt === "string" && role === "user") {
    return value.prompt.trim();
  }
  if (typeof value.output === "string" && role === "assistant") {
    return value.output.trim();
  }

  if (value.content) {
    return contentToText(value.content, role);
  }
  if (value.parts) {
    return contentToText(value.parts, role);
  }

  return "";
}

function findRoleText(value, role, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = findRoleText(item, role, depth + 1);
      if (text) {
        return text;
      }
    }
    return "";
  }

  const localRole = String(value.role || "").toLowerCase();
  if ((role === "user" && USER_TYPES.has(localRole)) || (role === "assistant" && ASSISTANT_TYPES.has(localRole))) {
    return contentToText(value.content || value.text || value.message || value.parts, role);
  }

  for (const item of Object.values(value)) {
    const text = findRoleText(item, role, depth + 1);
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeUsage(value) {
  const candidates = [];
  collectObjects(value, candidates);

  for (const candidate of candidates) {
    const inputTokens = numberFromKeys(candidate, [
      "input_tokens",
      "prompt_tokens",
      "inputTokens",
      "promptTokens",
      "tokens_in",
      "tokensIn"
    ]);
    const outputTokens = numberFromKeys(candidate, [
      "output_tokens",
      "completion_tokens",
      "outputTokens",
      "completionTokens",
      "tokens_out",
      "tokensOut",
      "generated_tokens"
    ]);
    const totalTokens = numberFromKeys(candidate, ["total_tokens", "totalTokens", "tokens", "total"]);
    const cacheReadTokens = numberFromKeys(candidate, ["cache_read_input_tokens", "cached_input_tokens", "cacheReadInputTokens"]);
    const cacheCreationTokens = numberFromKeys(candidate, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    const reasoningOutputTokens = numberFromKeys(candidate, [
      "reasoning_output_tokens",
      "reasoningOutputTokens",
      "reasoning_tokens",
      "reasoningTokens"
    ]);

    if (
      inputTokens != null
      || outputTokens != null
      || totalTokens != null
      || cacheReadTokens != null
      || cacheCreationTokens != null
      || reasoningOutputTokens != null
    ) {
      const normalizedInput = inputTokens || 0;
      const normalizedOutput = outputTokens || 0;

      return {
        inputTokens: normalizedInput,
        outputTokens: normalizedOutput,
        totalTokens: totalTokens || normalizedInput + normalizedOutput,
        cachedInputTokens: cacheReadTokens || 0,
        cacheReadTokens: cacheReadTokens || 0,
        cacheCreationTokens: cacheCreationTokens || 0,
        reasoningOutputTokens: reasoningOutputTokens || 0,
        tokenSource: "reported"
      };
    }
  }

  return null;
}

function applyUsage(record, usage) {
  record.inputTokens = usage.inputTokens || 0;
  record.outputTokens = usage.outputTokens || 0;
  record.totalTokens = usage.totalTokens || record.inputTokens + record.outputTokens;
  record.cachedInputTokens = usage.cachedInputTokens || usage.cacheReadTokens || 0;
  record.cacheReadTokens = usage.cacheReadTokens || 0;
  record.cacheCreationTokens = usage.cacheCreationTokens || 0;
  record.reasoningOutputTokens = usage.reasoningOutputTokens || 0;
  record.tokenSource = usage.tokenSource || "reported";
  record.hasReportedUsage = true;
}

function createRecord({
  source,
  filePath,
  lineNumber,
  timestamp,
  completedAt = null,
  conversationId,
  requestId,
  model,
  prompt,
  output,
  usage,
  status = "completed",
  projectPath = "",
  projectName = "",
  workspaceRoots = []
}) {
  const measuredUsage = usage || estimateUsage(prompt, output);
  const normalizedTimestamp = normalizeTimestamp(timestamp);
  const stableMaterial = [source.id, filePath, lineNumber, conversationId, requestId, prompt.slice(0, 200), output.slice(0, 200)].join("|");
  const id = crypto.createHash("sha1").update(stableMaterial).digest("hex");
  const normalizedProjectPath = projectPath || "";

  return {
    id,
    sourceId: source.id,
    sourceName: source.label,
    sourceKind: source.kind,
    ide: source.ide,
    provider: source.provider,
    model: model || inferModel({ source, filePath, text: `${prompt}\n${output}` }),
    projectPath: normalizedProjectPath,
    projectName: projectName || projectNameFromPath(normalizedProjectPath),
    workspaceRoots: Array.isArray(workspaceRoots) ? workspaceRoots : [],
    prompt,
    output,
    inputTokens: measuredUsage.inputTokens || 0,
    outputTokens: measuredUsage.outputTokens || 0,
    totalTokens: measuredUsage.totalTokens || 0,
    cachedInputTokens: measuredUsage.cachedInputTokens || measuredUsage.cacheReadTokens || 0,
    cacheReadTokens: measuredUsage.cacheReadTokens || 0,
    cacheCreationTokens: measuredUsage.cacheCreationTokens || 0,
    reasoningOutputTokens: measuredUsage.reasoningOutputTokens || 0,
    tokenSource: measuredUsage.tokenSource || "estimated",
    hasReportedUsage: measuredUsage.tokenSource === "reported",
    status,
    timestamp: normalizedTimestamp,
    completedAt: completedAt ? normalizeTimestamp(completedAt) : null,
    filePath,
    lineNumber,
    conversationId,
    requestId
  };
}

function dedupeRecords(records) {
  const seen = new Set();
  const unique = [];

  for (const record of records) {
    if (seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    unique.push(record);
  }

  return unique;
}

function inferModel({ source, filePath, text = "" }) {
  const combined = `${text}\n${source.label}`.slice(0, 10_000);
  for (const hint of MODEL_HINTS) {
    const match = combined.match(hint);
    if (match?.[0]) {
      return cleanModelName(match[0]);
    }
  }

  if (source.kind === "claude") {
    return "Claude (detected)";
  }
  if (source.kind === "codex" || source.provider === "OpenAI") {
    return "OpenAI Codex / GPT (detected)";
  }

  return "Unknown model";
}

function findModel(value, depth = 0) {
  if (!value || depth > 8) {
    return "";
  }

  if (typeof value === "string") {
    for (const hint of MODEL_HINTS) {
      const match = value.match(hint);
      if (match?.[0]) {
        return cleanModelName(match[0]);
      }
    }
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const model = findModel(item, depth + 1);
      if (model) {
        return model;
      }
    }
    return "";
  }

  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/model|engine|deployment/iu.test(key) && typeof item === "string") {
        return cleanModelName(item);
      }

      const model = findModel(item, depth + 1);
      if (model) {
        return model;
      }
    }
  }

  return "";
}

function cleanModelName(value) {
  return String(value).replace(/^model[:=\s]+/iu, "").trim();
}

function findFirstString(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) {
    return null;
  }

  for (const key of keys) {
    if (typeof value[key] === "string" || typeof value[key] === "number") {
      return String(value[key]);
    }
  }

  for (const item of Object.values(value)) {
    const found = findFirstString(item, keys, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
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

function collectObjects(value, output, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return;
  }

  if (!Array.isArray(value)) {
    output.push(value);
  }

  for (const item of Object.values(value)) {
    collectObjects(item, output, depth + 1);
  }
}

function flattenLikelyMessageArrays(value) {
  const output = [];
  visit(value);
  return output.length > 0 ? output : [value];

  function visit(item, depth = 0) {
    if (!item || typeof item !== "object" || depth > 5) {
      return;
    }

    if (Array.isArray(item)) {
      if (item.some((entry) => entry && typeof entry === "object" && (entry.role || entry.type || entry.message || entry.payload))) {
        output.push(...item);
      } else {
        item.forEach((entry) => visit(entry, depth + 1));
      }
      return;
    }

    for (const child of Object.values(item)) {
      visit(child, depth + 1);
    }
  }
}

function firstWorkspaceRoot(roots) {
  return Array.isArray(roots) && roots.length > 0 ? roots[0] : "";
}

function projectNameFromPath(projectPath) {
  if (!projectPath) {
    return "";
  }

  return path.basename(projectPath) || projectPath;
}

function normalizeTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function looksLikeJson(value) {
  return value.startsWith("{") || value.startsWith("[");
}
