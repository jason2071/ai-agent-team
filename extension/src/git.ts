// Port of the git_* Tauri commands (src-tauri/src/agent.rs) to Node.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function resolveGit(): string {
  for (const c of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "git";
}

function binDirs(): string {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].join(":");
  const base = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return `${extra}:${base}`;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!cwd) {
      reject(new Error("ไม่มี project directory (cwd)"));
      return;
    }
    execFile(
      resolveGit(),
      args,
      { cwd, env: { ...process.env, PATH: binDirs() } },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || "").trim();
          reject(new Error(msg || `git ${args.join(" ")} ล้มเหลว`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

// Start a fresh branch for a pipeline run: must be a git repo with a clean tree.
export async function gitBranchStart(cwd: string, branch: string): Promise<void> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("ไม่ใช่ git repo (init/เลือก folder ที่เป็น git ก่อน)");
  }
  const dirty = await runGit(cwd, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error("working tree มี uncommitted changes — commit/stash ก่อนเริ่ม pipeline");
  }
  await runGit(cwd, ["switch", "-c", branch]);
}

// Commit everything on the current branch. Returns short hash, or "(no changes)".
export async function gitCommitAll(cwd: string, message: string): Promise<string> {
  await runGit(cwd, ["add", "-A"]);
  const staged = await runGit(cwd, ["status", "--porcelain"]);
  if (!staged) return "(no changes)";
  await runGit(cwd, ["commit", "-m", message]);
  return runGit(cwd, ["rev-parse", "--short", "HEAD"]);
}
