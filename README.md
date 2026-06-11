# IDE Model Token Tracker

This repo contains two local tools:

- `vscode-extension/`: installable VS Code extension with graph-based token analysis.
- `electron/` + `src/`: desktop dashboard companion.

The VS Code extension is the main deliverable for Codex tracking.

## Install The Extension

Build the VSIX:

```powershell
npm run extension:package
```

Install it in VS Code:

```powershell
code --install-extension .\vscode-extension\dist\ide-token-graph-tracker-0.6.0.vsix
```

After install, open the `Codex Tokens` activity bar item or run:

```text
Codex Token Tracker: Open Dashboard
```

## What It Tracks

- Codex local session logs
- Custom Codex folders you add from the dashboard

Each captured turn stores source, IDE, model, prompt, output, input tokens, output tokens, total tokens, and whether the count was `reported` or `estimated`.

`reported` means the extension found real `last_token_usage` written by Codex. `estimated` means a running/incomplete Codex record has text but no token usage metadata yet.

The VS Code extension captures in near real time by watching local AI logs. It cannot read text before submission from another extension's private chat UI because VS Code blocks that for privacy/security.

The extension is tuned for low lag: real-time file watchers first, 60-second safety scans, bounded realtime batches, capped dashboard payloads, and configurable file/source limits.

## Useful Commands

```powershell
npm run extension:smoke
npm run extension:package
npm run build
```
"# codex-Token-Calculator" 
