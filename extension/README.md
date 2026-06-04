# Forgeline — AI Agent Team (VS Code extension)

Drive a team of Claude Code agents from inside VS Code. Opens a "guild office"
webview where each agent is a local `claude` CLI process (subscription / OAuth —
**not** the Anthropic API).

## Requirements

- [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) installed and logged in
  (`npm i -g @anthropic-ai/claude-code` then `claude` login).
- VS Code ^1.84.

> Do **not** set `ANTHROPIC_API_KEY` — the extension strips it from the child env
> so `claude` uses your subscription. A stray key forces API billing.

## Run / develop

```bash
# from extension/
npm install
npm run build      # builds webview (vite) + host (esbuild) into dist/
```

Then press **F5** in VS Code (uses `.vscode/launch.json`) → an Extension
Development Host opens → run command **Forgeline: Open Office**.

Fast UI iteration without the extension host:

```bash
cd webview && npm run dev   # plain Vite; host-backed actions are no-ops
```

## Package

```bash
cd extension && npm run package   # → forgeline-0.2.1.vsix
```

## Architecture

```
webview/   React 18 + Vite UI (the former Tauri frontend)
  src/platform/   adapter: invoke/Channel/open/save over postMessage
extension/ VS Code host (Node)
  src/extension.ts   activate → WebviewPanel
  src/bridge.ts      postMessage dispatch (invoke ↔ command)
  src/agentRunner.ts spawn claude, parse stream-json (port of agent.rs)
  src/git.ts files.ts
```

The webview ↔ host bridge replaces Tauri's IPC `Channel`. See
`docs/vscode-migration.md` for the full mapping.
