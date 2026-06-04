# Tauri → VS Code extension migration

Branch `feature/vscode-extension`. `main` stays the Tauri desktop app.

## Layout (this branch)

```
extension/        VS Code extension host (Node, esbuild-bundled)
  src/extension.ts    activate(): register "forgeline.openOffice", create WebviewPanel
  src/panel.ts        build webview HTML — inject <base href> + CSP into vite output
  src/bridge.ts       webview→host message dispatch (invoke + dialogs)
  src/agentRunner.ts  spawn `claude`, parse stream-json → StreamEvent (port of agent.rs)
  src/git.ts          gitBranchStart / gitCommitAll (port of run_git)
  src/files.ts        readFileText / writeFileText
  esbuild.mjs         bundle host → dist/extension.js
  package.json        VS Code manifest (the packaged unit)
webview/          React UI (the former root frontend, git-moved)
  vite.config.ts      base:"./", build → ../extension/dist/webview
  src/platform/       adapter exposing invoke/Channel/open/save over postMessage
src-tauri/        KEPT until the extension is verified, then deleted
.vscode/          launch.json (F5) + tasks.json (preLaunchTask build)
```

## Bridge mapping

| Tauri (main) | VS Code extension (this branch) |
|---|---|
| `invoke("run_agent", {args, onEvent: Channel})` | `postMessage {type:"invoke", cmd:"run_agent", params:{args, onEvent:{__channel}}}` → host `runAgent`, streams back `{type:"stream", channelId, event}` |
| Rust `Channel<StreamEvent>` | `Channel` class in `platform/index.ts` (id + onmessage), host streams by channelId |
| `invoke("cancel_agent")` | command `cancel_agent` → `cancelAgent()` |
| `invoke("git_branch_start"/"git_commit_all")` | `git.ts` via `execFile` |
| `invoke("read_file_text"/"write_file_text")` | `files.ts` via `node:fs` |
| `open`/`save` (plugin-dialog) | `dialog_open`/`dialog_save` → `vscode.window.showOpen/SaveDialog` |
| `localStorage` (`ai-agent-team:*`) | webview `localStorage` (kept; `retainContextWhenHidden` preserves it) |
| `cwd` safety boundary | unchanged — agent cwd / projectDir still explicit |
| `env_remove("ANTHROPIC_API_KEY"/"ANTHROPIC_AUTH_TOKEN")` | `agentRunner.childEnv()` deletes both |
| PATH augmentation (homebrew/nvm/.local) | `agentRunner.claudeBinDirs()` |

The `StreamEvent` union (`kind` + snake_case fields) is the contract shared by
`agentRunner.ts` (emit) and `webview/src/App.tsx` (consume) — keep them in sync,
exactly as the Rust enum and TS union were before.

## Assets

Vite `base:"./"` emits relative bundle URLs. Runtime public assets were rewritten
from `/assets/…` → `assets/…` (relative). At runtime the host injects
`<base href="<asWebviewUri(dist/webview)>/">`, so every relative URL resolves to a
`vscode-webview://` URI. CSP allows `img-src cspSource`, inline styles, and the
Google-Fonts CDN.

## Verify (manual, in VS Code)

1. `cd extension && npm install && npm run build`
2. F5 → Extension Development Host → **Forgeline: Open Office**
3. Office renders (bg + avatars load), click an agent → chat opens
4. Send a prompt → streaming deltas appear, tool status (🔧) shows, cost logs on done
5. Pick project folder (dialog), run a pipeline (git branch), attach a file

## Remaining cleanup (after verify)

- Delete `src-tauri/`, root `package.json` Tauri deps/scripts, `.github/workflows/release.yml` (Tauri build).
- Update root `README.md` to point at the extension.
- Consider swapping webview `localStorage` for `context.globalState` if persistence proves flaky.
