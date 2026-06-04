import * as vscode from "vscode";
import { runAgent, cancelAgent, type RunArgs, type StreamEvent } from "./agentRunner";
import { gitBranchStart, gitCommitAll } from "./git";
import { readFileText, writeFileText } from "./files";

// Message protocol — keep in sync with webview/src/platform/index.ts.
type Post = (msg: unknown) => void;

interface InvokeMsg {
  __forge: true;
  type: "invoke";
  reqId: number;
  cmd: string;
  params: Record<string, unknown>;
}

export function registerBridge(webview: vscode.Webview): vscode.Disposable {
  const post: Post = (m) => void webview.postMessage(m);

  return webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = raw as InvokeMsg | undefined;
    if (!msg || msg.__forge !== true || msg.type !== "invoke") return;
    const { reqId, cmd, params } = msg;
    try {
      const value = await dispatch(cmd, params ?? {}, post);
      post({ __forge: true, type: "result", reqId, ok: true, value });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      post({ __forge: true, type: "result", reqId, ok: false, error });
    }
  });
}

async function dispatch(cmd: string, params: Record<string, unknown>, post: Post): Promise<unknown> {
  switch (cmd) {
    case "run_agent": {
      const args = params.args as RunArgs;
      const channelId = (params.onEvent as { __channel?: number } | undefined)?.__channel;
      const emit = (ev: StreamEvent) => {
        if (channelId != null) post({ __forge: true, type: "stream", channelId, event: ev });
        if (ev.kind === "done" || ev.kind === "error") {
          if (channelId != null) post({ __forge: true, type: "stream_end", channelId });
        }
      };
      await runAgent(args, emit); // resolves at spawn; stream continues via emit
      return undefined;
    }
    case "cancel_agent": {
      cancelAgent(String(params.agentId));
      return undefined;
    }
    case "git_branch_start": {
      await gitBranchStart(String(params.cwd), String(params.branch));
      return undefined;
    }
    case "git_commit_all": {
      return await gitCommitAll(String(params.cwd), String(params.message));
    }
    case "read_file_text": {
      return readFileText(String(params.path));
    }
    case "write_file_text": {
      writeFileText(String(params.path), String(params.content));
      return undefined;
    }
    case "dialog_open": {
      return dialogOpen(params.opts as OpenOpts | undefined);
    }
    case "dialog_save": {
      return dialogSave(params.opts as SaveOpts | undefined);
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

interface DialogFilter {
  name: string;
  extensions: string[];
}
interface OpenOpts {
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: DialogFilter[];
}
interface SaveOpts {
  defaultPath?: string;
  filters?: DialogFilter[];
}

function mapFilters(filters?: DialogFilter[]): Record<string, string[]> | undefined {
  if (!filters || !filters.length) return undefined;
  const out: Record<string, string[]> = {};
  for (const f of filters) out[f.name] = f.extensions;
  return out;
}

async function dialogOpen(opts: OpenOpts = {}): Promise<string | string[] | null> {
  const sel = await vscode.window.showOpenDialog({
    canSelectFiles: !opts.directory,
    canSelectFolders: !!opts.directory,
    canSelectMany: !!opts.multiple,
    defaultUri: opts.defaultPath ? vscode.Uri.file(opts.defaultPath) : undefined,
    filters: mapFilters(opts.filters),
  });
  if (!sel || !sel.length) return null;
  const paths = sel.map((u) => u.fsPath);
  return opts.multiple ? paths : paths[0];
}

async function dialogSave(opts: SaveOpts = {}): Promise<string | null> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: opts.defaultPath ? vscode.Uri.file(opts.defaultPath) : undefined,
    filters: mapFilters(opts.filters),
  });
  return uri ? uri.fsPath : null;
}
