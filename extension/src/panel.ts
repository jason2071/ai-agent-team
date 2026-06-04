import * as vscode from "vscode";
import * as fs from "node:fs";

// Build the webview HTML from the Vite-built index.html.
// Vite emits relative ("./assets/...") URLs (base:"./"); a <base href> pointing at
// the webview-mapped dist dir makes both the bundle AND runtime public assets
// (e.g. "assets/bg/guild.png") resolve to vscode-webview:// URIs.
export function getHtml(webview: vscode.Webview, distWebview: vscode.Uri): string {
  const indexPath = vscode.Uri.joinPath(distWebview, "index.html");
  let html = fs.readFileSync(indexPath.fsPath, "utf8");

  const baseUri = webview.asWebviewUri(distWebview).toString().replace(/\/?$/, "/");
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${webview.cspSource} https://fonts.gstatic.com`,
    `script-src ${webview.cspSource}`,
  ].join("; ");

  const inject = `<base href="${baseUri}">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (html.includes("<head>")) {
    html = html.replace("<head>", `<head>\n  ${inject}`);
  } else {
    html = html.replace("<head ", `<head>\n  ${inject}\n<head_orig `); // defensive; vite always emits <head>
  }
  return html;
}
