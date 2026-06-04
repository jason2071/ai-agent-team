// Platform adapter — drop-in replacement for the Tauri APIs the app used to call.
// Same signatures as `@tauri-apps/api/core` (invoke, Channel) and
// `@tauri-apps/plugin-dialog` (open, save), but implemented over the VS Code
// webview <-> extension-host postMessage bridge. App.tsx imports from here, so
// the orchestration logic stays untouched.
//
// Protocol (must stay in sync with extension/src/bridge.ts):
//   webview -> host : { __forge, type:"invoke", reqId, cmd, params }
//   host -> webview : { __forge, type:"result", reqId, ok, value?, error? }
//   host -> webview : { __forge, type:"stream", channelId, event }   (run_agent stream)
//   host -> webview : { __forge, type:"stream_end", channelId }

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi() may be called only once per webview — cache it.
// Fallback stub for standalone `npm run dev` in a plain browser (UI renders,
// host-backed actions become no-ops) so the design loop still works outside VS Code.
const g = globalThis as unknown as { acquireVsCodeApi?: () => VsCodeApi };
export const vscode: VsCodeApi =
  typeof g.acquireVsCodeApi === "function"
    ? g.acquireVsCodeApi()
    : {
        postMessage: (m: unknown) => console.warn("[forgeline] no VS Code host; dropped", m),
        getState: () => undefined,
        setState: () => {},
      };

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const channels = new Map<number, Channel<unknown>>();

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || msg.__forge !== true) return;
  switch (msg.type) {
    case "result": {
      const p = pending.get(msg.reqId);
      if (!p) return;
      pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(typeof msg.error === "string" ? msg.error : "command failed"));
      return;
    }
    case "stream": {
      const ch = channels.get(msg.channelId);
      ch?.onmessage?.(msg.event);
      return;
    }
    case "stream_end": {
      channels.delete(msg.channelId);
      return;
    }
  }
});

// Mirrors Tauri's ipc Channel: create one, set .onmessage, pass it as an invoke arg.
export class Channel<T = unknown> {
  readonly __channelId: number;
  onmessage: ((message: T) => void) | null = null;
  constructor() {
    this.__channelId = ++seq;
    channels.set(this.__channelId, this as Channel<unknown>);
  }
}

function isChannel(v: unknown): v is Channel<unknown> {
  return v instanceof Channel;
}

export function invoke<T = unknown>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
  const reqId = ++seq;
  // Replace any Channel arg with a serializable handle the host can stream back to.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = isChannel(v) ? { __channel: v.__channelId } : v;
  }
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ __forge: true, type: "invoke", reqId, cmd, params: out });
  });
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: DialogFilter[];
}
export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: DialogFilter[];
}

// open(): folder/file picker. Returns absolute fsPath(s) or null (cancelled).
export function open(opts: OpenDialogOptions = {}): Promise<string | string[] | null> {
  return invoke<string | string[] | null>("dialog_open", { opts });
}

// save(): save-file picker. Returns absolute fsPath or null (cancelled).
export function save(opts: SaveDialogOptions = {}): Promise<string | null> {
  return invoke<string | null>("dialog_save", { opts });
}
