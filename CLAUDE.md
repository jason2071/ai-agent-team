# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**AI Agent Team** — a Tauri 2 (Rust) + React 18 + TypeScript desktop app. The app and all source live at the **repo root** (`src/`, `src-tauri/`); there is no nested project subdirectory.

The app spawns the local **Claude Code CLI** (`claude -p ...`) as a child process per agent. It is NOT an Anthropic-SDK / API app — it drives the user's installed `claude` binary and relies on their Pro/Max subscription login. Do not introduce `ANTHROPIC_API_KEY` usage; the README warns that setting it forces API billing instead of subscription.

## Commands

Run from the repo root:

```bash
npm install            # install JS deps
npm run tauri dev      # run desktop app (Vite dev server on :1420 + Rust)
npm run tauri build    # production build
npm run dev            # frontend only (Vite), no Rust shell — instant reload
npm run build          # tsc typecheck + vite build (frontend dist)
npm run tauri icon path/to/logo.png   # regenerate platform icons
```

There is no test suite, linter, or formatter. `npm run build` (= `tsc && vite build`) is the only typecheck/verification step.

Prerequisites: Node, Rust toolchain (`rustup`), Tauri system deps, and Claude Code installed + logged in (`npm i -g @anthropic-ai/claude-code` then `claude` login).

CI: `.github/workflows/release.yml` builds cross-platform installers (macOS universal `.dmg`, Windows `.msi`/NSIS `.exe`) via `tauri-action`. Triggered by pushing a `v*` tag (publishes a **draft** release); `workflow_dispatch` builds without publishing.

## Architecture

A single IPC command bridges the two halves. One request → many streamed events, delivered over a Tauri **ipc `Channel`** (point-to-point — replaced the old global `emit`/`listen("agent://stream")`, which had listener-registration races):

```
React (App.tsx) ──invoke("run_agent", {args, onEvent: Channel})──► Rust (src-tauri/src/agent.rs)
                                                    │ spawns: claude -p <prompt>
                                                    │   --append-system-prompt <persona>
                                                    │   --output-format stream-json --verbose
                                                    │   [--model M] [--resume SID] [--allowedTools ...]
                                                    ▼
                                          reads stdout line-by-line (one JSON object/line)
React onEvent.onmessage ◄──── Channel.send(StreamEvent) ────────────┘
```

**Rust side (`src-tauri/src/agent.rs`):** The single `#[tauri::command] run_agent` takes `RunArgs` + an `on_event: Channel<StreamEvent>`, builds a `claude` `Command`, spawns it, and reads stdout on a background thread. Each stdout line is parsed as JSON and translated from the CLI's `stream-json` protocol into a typed `StreamEvent`:
- first `session_id` seen → `Session` (frontend stores it for multi-turn resume)
- `type: "assistant"` text blocks → `Delta` (incremental output); thinking/system → `System`
- `result` with `total_cost_usd` / `usage.{input,output}_tokens` → `Usage` (cost + token meta)
- `type: "result"` → `Done`; spawn/parse failures → `Error`

stderr is logged but **not** surfaced as an error event (claude writes warnings/hook noise there).

`StreamEvent` serializes with `#[serde(tag = "kind", rename_all = "snake_case")]`. The `kind` discriminant + snake_case field names are the contract the React `StreamEvent` union must match **exactly**. Current variants: `session`, `delta`, `system`, `usage` (`cost_usd`, `input_tokens`, `output_tokens`), `done`, `error`. When changing the protocol, update **both** the Rust enum and the TS union in `App.tsx` — they are hand-kept in sync.

**React side (`src/App.tsx`):** Single large file holding the UI and all orchestration. Per-agent chat history (`chats`), per-agent `sessions` (session_id for resume), per-agent `cwds`, a global `projectDir`, and cumulative `totals` (cost/tokens) — all persisted to `localStorage` (keys prefixed `ai-agent-team:`). Each `send()` creates a fresh `Channel`, optimistically appends a user message + empty assistant placeholder, then `invoke`s `run_agent`. `effectiveCwd(id)` resolves an agent's working dir: own override → global project → `null`.

**Agents (`src/agents.ts`):** The `AGENTS` array is the heart of customization. Each `Agent` is a `persona` (system prompt) plus presentation (accent color, bg gradient, avatar/initials) and capability config (`model`, `allowedTools`). `allowedTools` empty/absent = read-only; `["Read","Edit","Bash"]` lets the agent modify files and run commands. Users can also create/edit agents at runtime (persisted to `localStorage`, see `ManageAgents.tsx`).

**Workflow engine (`src/workflow.ts` + `App.tsx`):** A preset DAG runner. `workflow.ts` defines pure types + presets only — node kinds `task | gate | fork | join | done`. The engine itself lives in `App.tsx` (`startWorkflow`/`startWFNode`), driven by `done`/`error` stream events; `WFRun` is held in a ref (avoids stale closures in the event handler) mirrored to state for render.
- **gate** nodes route on the reviewer's verdict: `GATE_RULE` is appended to the reviewer prompt instructing it to end with `VERDICT: PASS|FAIL`; `parseVerdict()` reads the **last** marker; FAIL loops back to the author (feeding the review back as feedback) up to `maxRetry`.
- **fork/join** run branches; `join` waits for `expected` branches before continuing.
- Each run accumulates cost/tokens; finished/halted runs are archived to `wf-history` (last 20) in `localStorage`.
- `FEATURE_WF` is the built-in preset: architect → uxui → fork(backend API ∥ frontend web) → gated review loops → frontend integrate → gated review → done.

**Visual pipeline builder (`src/components/PipelineBuilder.tsx`):** A React Flow (`@xyflow/react`) graph editor letting users compose custom agent pipelines. User graphs/steps convert to a runnable `Workflow` via `graphToWorkflow()` / `buildWorkflow()`; saved pipelines persist to `localStorage`.

**Other components (`src/components/`):** `OfficeView.tsx` (the agent roster screen, themed "Guild / กิลด์นักผจญภัย" — UI text only), `ManageAgents.tsx` (agent CRUD), `Avatar.tsx`. Agent output is rendered with `react-markdown` + `remark-gfm` + `rehype-highlight` (highlight.js).

## Key conventions

- **Personas answer in Thai, keep code/technical terms in English.** All built-in agent personas state this; preserve it when editing or adding agents.
- **`cwd` is the safety boundary.** An agent with no `cwd` has no project dir. Setting `cwd`/`projectDir` to a real path lets agents with `Edit`/`Bash` read and modify real files there — handle with care. Note: `--resume` fails across a changed `cwd` ("No conversation found"), so drop the stored session when the folder changes.
- **The CLI flags in `agent.rs` are version-sensitive.** `--output-format stream-json` requires `--verbose` when combined with `-p`. If `claude -p --help` changes in a new version, the JSON-parsing logic in `agent.rs` may need updating.

## Build & runtime gotchas (hard-won)

- **`tauri build`/`dev` needs the Rust toolchain** (`rustup`) — not installed by `npm install`. Without `cargo` the build fails early with `failed to run 'cargo metadata'`.
- **`src-tauri/icons/icon.png` MUST be RGBA**, not RGB. A non-RGBA icon makes `generate_context!()` panic at compile time (`error: proc macro panicked ... icon ... is not RGBA`). Fix: convert in place (`Image.open(p).convert("RGBA").save(p)`) or regen via `tauri icon`.
- **`agent.rs` resolves `claude` by absolute path and patches the child's env** (`resolve_claude()` + PATH augmentation + `env_remove("ANTHROPIC_API_KEY")` / `ANTHROPIC_AUTH_TOKEN`). This is deliberate: a GUI app launched from Finder/Launchpad only inherits PATH `/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `Command::new("claude")` fails with `No such file or directory`, and a stray `ANTHROPIC_API_KEY` would force API billing / "Invalid API key" instead of subscription auth. Keep these when editing the spawn logic.
- **`.app`/`.dmg` are not codesigned/notarized** — first launch needs right-click → Open (Gatekeeper); Windows builds are unsigned (SmartScreen → More info → Run anyway). `bundle_dmg.sh` fails if a previous `AI Agent Team` volume is still mounted under `/Volumes` — detach it (`hdiutil detach`) before rebuilding.
- **Dev port is fixed at 1420** (`strictPort: true` in `vite.config.ts`). A leftover Vite from a killed run blocks `tauri dev` with `Port 1420 is already in use`; kill the holder (`lsof -ti tcp:1420`).
- **You almost never need to reinstall during dev.** Vite HMR hot-reloads `src/` edits; `tauri dev` watches `src-tauri/` and recompiles Rust incrementally. Reinstall/clean is only warranted when: `package.json` deps changed (`npm install`), `Cargo.toml` deps changed (auto on next build), or the project directory was **moved/copied** (see next). Keep `node_modules/` and `src-tauri/target/` — incremental rebuilds are seconds; a full `cargo clean` throws away ~1.4 GB and forces a ~1-min cold recompile.
- **Moving/copying the project dir breaks `target/`** — the Rust build cache bakes in absolute paths, so after a move `cargo build`/`dev` fails with e.g. `failed to read plugin permissions: ... /old/path/.../app_hide.toml: No such file or directory`. Fix is `cd src-tauri && cargo clean` once (NOT a full npm reinstall — node_modules has no absolute-path coupling).
- **Frontend-only iteration: run `npm run dev` (Vite alone)** instead of `npm run tauri dev` — instant reload, skips Rust compile. Use the full `tauri dev` only when touching `src-tauri/`.
