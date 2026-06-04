import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Webview build for the VS Code extension.
// - base "./" so emitted asset URLs are relative (resolved to vscode-webview:// via the
//   injected <base href> at runtime — see extension/src/panel.ts)
// - output goes straight into the extension bundle dir
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  // dev server (npm run dev) still works standalone for fast UI iteration
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "../extension/dist/webview",
    emptyOutDir: true,
  },
});
