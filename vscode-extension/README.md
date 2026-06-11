# Codex Token Tracker

Local VS Code extension for tracking Codex usage from local session logs in near real time.

It records:

- detected source and IDE
- model name
- reported token usage from Codex `last_token_usage`
- estimated token usage when no reported usage exists
- prompt text and output text
- current VS Code folder token usage
- project-folder-wise prompt/token rollups
- graph relationships between sources, models, folders, and daily usage

## Accuracy

Codex records are marked `reported` when the local session JSONL includes `event_msg / token_count` with `last_token_usage`. Those records use the token counts written by Codex itself.

If a log only contains prompt/output text, the extension keeps the record but marks token usage as `estimated`.

## Install

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\vscode-extension\scripts\package-vsix.ps1
code --install-extension .\vscode-extension\dist\ide-token-graph-tracker-0.9.0.vsix
```

Then open VS Code and use the `Codex Tokens` activity bar item.

## Realtime Capture

The extension watches the Codex session folder and parses changed rollout JSONL files immediately, so submitted prompts, responses, model names, and reported token usage appear in the graph as Codex writes them.

Production defaults are tuned to avoid VS Code lag:

- realtime file watching first
- full safety scan only every 60 seconds
- changed-file parsing in bounded batches
- dashboard receives only recent records; export still includes everything
- large files and huge source scans are capped by settings
- dashboard rendering is batched and the ledger paints a capped recent slice
- per-prompt token consumption and project-folder rollups are rendered as compact bar lists

## Folder-wise Tracking

The dashboard detects the current VS Code workspace folder and shows only that
folder's token summary plus prompt-wise token usage. It does not show other
project folders in the UI. Prompt rows include the prompt text, token breakdown,
model, timestamp, and reported/running status; selecting a row opens the full
prompt detail.

## Installation Scanner

The dashboard shows where Codex is present on the PC:

- `~/.codex`
- `~/.codex/sessions`
- Codex config/auth/index files
- Codex CLI found on `PATH`
- VS Code/Cursor extension folders that match Codex/OpenAI
- editor storage folders that match Codex/OpenAI
- running `code`, `codex`, and `node` processes

This Codex-only build captures submitted prompts and model responses from local Codex logs. If a Codex record has not yet received a `token_count` event while streaming, it is shown as running/estimated until Codex writes the reported usage.

## Commands

- `Codex Token Tracker: Open Dashboard`
- `Codex Token Tracker: Rescan Logs`
- `Codex Token Tracker: Add Log Folder`
- `Codex Token Tracker: Export Ledger JSON`
- `Codex Token Tracker: Open Local Storage`
