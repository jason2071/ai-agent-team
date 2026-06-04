import * as vscode from "vscode";
import { getHtml } from "./panel";
import { registerBridge } from "./bridge";

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const distWebview = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");

  const open = vscode.commands.registerCommand("forgeline.openOffice", () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    panel = vscode.window.createWebviewPanel(
      "forgelineOffice",
      "Forgeline",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // keep React state/localStorage while tab is hidden
        localResourceRoots: [distWebview],
      },
    );

    const bridge = registerBridge(panel.webview);
    panel.webview.html = getHtml(panel.webview, distWebview);

    panel.onDidDispose(
      () => {
        bridge.dispose();
        panel = undefined;
      },
      null,
      context.subscriptions,
    );
  });

  context.subscriptions.push(open);
}

export function deactivate() {
  panel?.dispose();
}
