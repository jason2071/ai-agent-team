// Port of src-tauri/src/agent.rs run_agent/cancel_agent to the Node extension host.
// Spawns the local `claude` CLI, parses its stream-json stdout, and emits typed
// StreamEvents (same `kind`/snake_case contract the webview App.tsx expects).
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── StreamEvent: must match the TS union in webview/src/App.tsx exactly ──
export type StreamEvent =
  | { kind: "session"; agent_id: string; session_id: string }
  | { kind: "delta"; agent_id: string; text: string }
  | { kind: "system"; agent_id: string; text: string }
  | { kind: "usage"; agent_id: string; cost_usd: number; input_tokens: number; output_tokens: number }
  | { kind: "done"; agent_id: string }
  | { kind: "error"; agent_id: string; message: string };

export interface RunArgs {
  agent_id: string;
  persona: string;
  prompt: string;
  model?: string | null;
  resume?: string | null;
  allowed_tools?: string[] | null;
  cwd?: string | null;
  permission_mode?: string | null;
}

// GUI/editor apps launched outside a login shell get a thin PATH that misses
// homebrew / nvm / ~/.local/bin → `claude` won't resolve. Mirror agent.rs:
// build the likely bin dirs, resolve claude's absolute path, and augment PATH.
function claudeBinDirs(): string[] {
  const dirs: string[] = [];
  const home = os.homedir();
  if (home) {
    dirs.push(path.join(home, ".local/bin"));
    dirs.push(path.join(home, ".bun/bin"));
    dirs.push(path.join(home, ".npm-global/bin"));
    const nvm = path.join(home, ".nvm/versions/node");
    try {
      const versions = fs
        .readdirSync(nvm)
        .map((v) => path.join(nvm, v, "bin"))
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
        .reverse();
      dirs.push(...versions);
    } catch {
      /* no nvm */
    }
  }
  dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");
  return dirs;
}

function resolveClaude(): string {
  for (const dir of claudeBinDirs()) {
    const candidate = path.join(dir, "claude");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return "claude"; // fall back to PATH
}

// env for the child: augment PATH + strip API key so claude uses subscription auth
// (a stray ANTHROPIC_API_KEY forces API billing / "Invalid API key").
function childEnv(): NodeJS.ProcessEnv {
  const extra = claudeBinDirs().join(":");
  const base = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${extra}:${base}` };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const children = new Map<string, ChildProcess>();

export function cancelAgent(agentId: string): void {
  const child = children.get(agentId);
  if (child) {
    children.delete(agentId);
    child.kill();
  }
}

// Spawn claude for one agent. Resolves once spawned (matching Tauri's run_agent,
// which returns Ok right after spawn); events stream via `emit` afterwards.
export function runAgent(args: RunArgs, emit: (ev: StreamEvent) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = args.agent_id;
    const argv: string[] = [
      "-p",
      args.prompt,
      "--append-system-prompt",
      args.persona,
      "--output-format",
      "stream-json",
      "--verbose", // required with stream-json + -p
    ];
    if (args.model) argv.push("--model", args.model);
    if (args.resume) argv.push("--resume", args.resume);
    if (args.allowed_tools && args.allowed_tools.length) {
      argv.push("--allowedTools", args.allowed_tools.join(","));
    }
    if (args.permission_mode) argv.push("--permission-mode", args.permission_mode);

    let child: ChildProcess;
    try {
      child = spawn(resolveClaude(), argv, {
        cwd: args.cwd && args.cwd.length ? args.cwd : undefined,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(
        new Error(
          `spawn claude failed: ${e} (ติดตั้ง Claude Code และ login ด้วย subscription แล้วหรือยัง?)`,
        ),
      );
      return;
    }

    child.on("error", (e) => {
      // spawn-time failure (binary not found etc) — surface as terminal error
      emit({ kind: "error", agent_id: id, message: `spawn claude failed: ${e.message}` });
    });

    children.set(id, child);

    // stderr: collect for diagnostics only (claude writes warnings even on exit 0)
    let stderrBuf = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
    });

    let sawResult = false;
    let sessionSent = false;
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(trimmed);
      } catch {
        return;
      }

      const sid = v["session_id"];
      if (!sessionSent && typeof sid === "string") {
        sessionSent = true;
        emit({ kind: "session", agent_id: id, session_id: sid });
      }

      const type = v["type"];
      if (type === "assistant") {
        const msg = v["message"] as { content?: unknown } | undefined;
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block["type"] === "text" && typeof block["text"] === "string") {
              emit({ kind: "delta", agent_id: id, text: block["text"] });
            } else if (block["type"] === "tool_use") {
              const name = typeof block["name"] === "string" ? block["name"] : "tool";
              emit({ kind: "system", agent_id: id, text: `🔧 ${name}` });
            }
          }
        }
      } else if (type === "result") {
        sawResult = true;
        const cost = typeof v["total_cost_usd"] === "number" ? (v["total_cost_usd"] as number) : 0;
        const usage = v["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
        const inTok = usage?.input_tokens ?? 0;
        const outTok = usage?.output_tokens ?? 0;
        if (cost > 0 || inTok > 0 || outTok > 0) {
          emit({ kind: "usage", agent_id: id, cost_usd: cost, input_tokens: inTok, output_tokens: outTok });
        }
        const isErr = v["is_error"] === true;
        if (isErr) {
          const subtype = typeof v["subtype"] === "string" ? (v["subtype"] as string) : undefined;
          const detail =
            (typeof v["result"] === "string" ? (v["result"] as string) : undefined) ??
            (typeof v["error"] === "string" ? (v["error"] as string) : undefined) ??
            tail(stderrBuf, 4);
          const message = subtype
            ? detail
              ? `${subtype}: ${detail}`
              : subtype
            : detail || "claude error (no detail)";
          emit({ kind: "error", agent_id: id, message });
        } else {
          emit({ kind: "done", agent_id: id });
        }
      }
    });

    child.on("close", () => {
      children.delete(id);
      if (!sawResult) {
        // crash / killed / hung — guarantee a terminal event so the UI never hangs busy
        const t = tail(stderrBuf, 6);
        emit({ kind: "error", agent_id: id, message: t || "งานจบผิดปกติ / ถูกหยุด" });
      }
    });

    resolve();
  });
}

// last N non-empty lines, joined — for surfacing stderr diagnostics
function tail(buf: string, n: number): string {
  const lines = buf
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-n).join(" | ");
}
