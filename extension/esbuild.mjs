import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"], // provided by the VS Code runtime
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[esbuild] watching host…");
} else {
  await build(opts);
}
