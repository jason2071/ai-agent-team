# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**AI Agent Team** — a Tauri 2 (Rust) + React 18 + TypeScript desktop app. The project lives in `ai-agent-team/`; the repo root holds only this file and a `ai-agent-team.zip` archive.

The app spawns the local **Claude Code CLI** (`claude -p ...`) as a child process per agent. It is NOT an Anthropic-SDK / API app — it drives the user's installed `claude` binary and relies on their Pro/Max subscription login. Do not introduce `ANTHROPIC_API_KEY` usage; the README warns that setting it forces API billing instead of subscription.

## Commands

Run from `ai-agent-team/`:

```bash
npm install            # install JS deps
npm run tauri dev      # run desktop app (Vite dev server on :1420 + Rust)
npm run tauri build    # production build
npm run dev            # frontend only (Vite), no Rust shell
npm run build          # tsc typecheck + vite build (frontend dist)
npm run tauri icon path/to/logo.png   # regenerate platform icons
```

There is no test suite, linter, or formatter configured. `npm run build` (= `tsc && vite build`) is the only typecheck/verification step.

Prerequisites: Node, Rust toolchain (`rustup`), Tauri system deps, and Claude Code installed + logged in (`npm i -g @anthropic-ai/claude-code` then `claude` login).

## Architecture

Single IPC command bridges the two halves. Data flows one request → many streamed events:

```
React (App.tsx) ──invoke("run_agent", {args})──► Rust (src-tauri/src/agent.rs)
                                                    │ spawns: claude -p <prompt>
                                                    │   --append-system-prompt <persona>
                                                    │   --output-format stream-json --verbose
                                                    ▼
                                          reads stdout line-by-line (one JSON object/line)
                                                    │ emits "agent://stream" events
React listen("agent://stream") ◄────────────────────┘
```

**Rust side (`src-tauri/src/agent.rs`):** The single `#[tauri::command] run_agent` builds a `claude` `Command` from `RunArgs`, spawns it, and reads stdout on a background thread. Each stdout line is parsed as JSON; it translates the CLI's `stream-json` protocol into a typed `StreamEvent` enum emitted to the frontend:
- first `session_id` seen → `Session` (frontend stores it for multi-turn resume)
- `type: "assistant"` → extracts text blocks → `Delta` (incremental output)
- `type: "result"` → `Done`
- stderr (separate thread) → `Error`

`StreamEvent` serializes with `#[serde(tag = "kind", rename_all = "snake_case")]` — the `kind` discriminant + snake_case field names are the contract the React `StreamEvent` union type must match exactly.

**React side (`src/App.tsx`):** Single-file UI. Holds per-agent chat history (`chats`) and per-agent `sessions` map (session_id for resume). One `listen("agent://stream")` subscription set up once on mount routes events by `agent_id`. `send()` optimistically appends a user message + empty assistant placeholder, then `invoke`s. Streaming deltas are concatenated onto the last assistant message via `appendDelta`. Multi-turn continuation works by passing the stored `session_id` as `resume`.

**Agents (`src/agents.ts`):** The `AGENTS` array is the heart of customization. Each `Agent` is essentially a `persona` (system prompt) plus presentation (accent color, bg gradient, avatar/initials) and capability config (`model`, `allowedTools`). `allowedTools` empty/absent = read-only; `["Read","Edit","Bash"]` lets the agent modify files and run commands. To add or change an agent's behavior, edit this file — no Rust changes needed.

## Key conventions

- **Personas answer in Thai, keep code/technical terms in English.** All built-in agent personas state this; preserve it when editing or adding agents.
- **`cwd` is the safety boundary.** In `App.tsx`, `run_agent` is invoked with `cwd: null` (agent has no project dir). Setting `cwd` to a real project path lets agents with `Edit`/`Bash` read and modify real files there — handle with care.
- **The CLI flags in `agent.rs` are version-sensitive.** `--output-format stream-json` requires `--verbose` when combined with `-p`. If `claude -p --help` changes in a new version, the JSON-parsing logic in `agent.rs` may need updating.
- When changing the event protocol, update **both** the Rust `StreamEvent` enum and the TS `StreamEvent` union — they are manually kept in sync.

## Build & runtime gotchas (hard-won)

- **`tauri build`/`dev` needs the Rust toolchain** (`rustup`) — not preinstalled by `npm install`. Without `cargo` the build fails early with `failed to run 'cargo metadata'`.
- **`src-tauri/icons/icon.png` MUST be RGBA**, not RGB. A non-RGBA icon makes `generate_context!()` panic at compile time (`error: proc macro panicked ... icon ... is not RGBA`). Fix: convert in place (`Image.open(p).convert("RGBA").save(p)`) or regen via `tauri icon`.
- **`agent.rs` resolves `claude` by absolute path and patches the child's env** (`resolve_claude()` + PATH augmentation + `env_remove("ANTHROPIC_API_KEY")`). This is deliberate: a GUI app launched from Finder/Launchpad only inherits PATH `/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `Command::new("claude")` fails with `No such file or directory`, and a stray `ANTHROPIC_API_KEY` in the env would force API billing / "Invalid API key" instead of subscription auth. Keep these when editing the spawn logic.
- **`.app`/`.dmg` are not codesigned/notarized** — first launch needs right-click → Open (Gatekeeper). `bundle_dmg.sh` fails if a previous `AI Agent Team` volume is still mounted under `/Volumes` — detach it (`hdiutil detach`) before rebuilding. The `.app` bundles fine regardless; only the DMG step is affected.
- **Dev port is fixed at 1420** (`strictPort: true` in `vite.config.ts`). A leftover Vite from a killed run blocks `tauri dev` with `Port 1420 is already in use`; kill the holder (`lsof -ti tcp:1420`).
