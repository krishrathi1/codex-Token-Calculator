const assert = require("assert");
const { buildGraph, parseUsageFile, summarizeRecords } = require("../core/tracker-core.cjs");

const source = {
  id: "codex-sessions",
  label: "Codex sessions",
  kind: "codex",
  ide: "Codex",
  provider: "OpenAI"
};

const codexLog = [
  JSON.stringify({
    timestamp: "2026-06-11T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "session-1", cwd: "C:\\Users\\KRISH\\Desktop\\1", workspace_roots: ["C:\\Users\\KRISH\\Desktop\\1"] }
  }),
  JSON.stringify({
    timestamp: "2026-06-11T10:00:01.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" }
  }),
  JSON.stringify({
    timestamp: "2026-06-11T10:00:01.100Z",
    type: "turn_context",
    payload: { turn_id: "turn-1", model: "gpt-5.5", cwd: "C:\\Users\\KRISH\\Desktop\\1", workspace_roots: ["C:\\Users\\KRISH\\Desktop\\1"] }
  }),
  JSON.stringify({
    timestamp: "2026-06-11T10:00:02.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Track my Codex token usage" }
  }),
  JSON.stringify({
    timestamp: "2026-06-11T10:00:03.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "Codex tracker is running." }
  }),
  JSON.stringify({
    timestamp: "2026-06-11T10:00:03.200Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 9999,
          cached_input_tokens: 8000,
          output_tokens: 9999,
          reasoning_output_tokens: 9999,
          total_tokens: 19998
        },
        last_token_usage: {
          input_tokens: 20,
          cached_input_tokens: 8,
          output_tokens: 6,
          reasoning_output_tokens: 2,
          total_tokens: 26
        }
      }
    }
  }),
  JSON.stringify({
    timestamp: "2026-06-11T10:00:04.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1", completed_at: "2026-06-11T10:00:04.000Z" }
  })
].join("\n");

const records = parseUsageFile({ source, filePath: "rollout-test.jsonl", raw: codexLog });
const summary = summarizeRecords(records);
const graph = buildGraph(records);

assert.strictEqual(records.length, 1);
assert.strictEqual(records[0].model, "gpt-5.5");
assert.strictEqual(records[0].projectName, "1");
assert.strictEqual(records[0].projectPath, "C:\\Users\\KRISH\\Desktop\\1");
assert.strictEqual(records[0].prompt, "Track my Codex token usage");
assert.strictEqual(records[0].output, "Codex tracker is running.");
assert.strictEqual(records[0].inputTokens, 20);
assert.strictEqual(records[0].cachedInputTokens, 8);
assert.strictEqual(records[0].outputTokens, 6);
assert.strictEqual(records[0].reasoningOutputTokens, 2);
assert.strictEqual(records[0].totalTokens, 26);
assert.strictEqual(records[0].tokenSource, "reported");
assert.strictEqual(records[0].status, "completed");
assert.strictEqual(summary.reportedTokenShare, 100);
assert.ok(graph.nodes.some((node) => node.type === "model" && node.label === "gpt-5.5"));
assert.ok(graph.nodes.some((node) => node.type === "project" && node.label === "1"));

console.log("codex parser smoke ok");
