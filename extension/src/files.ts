// Port of read_file_text / write_file_text Tauri commands to Node.
import * as fs from "node:fs";
import * as path from "node:path";

const MAX = 512 * 1024; // 512KB per file

// Read a text file (used for attach -> prepend into prompt). Rejects binary/oversize.
export function readFileText(p: string): string {
  const real = fs.realpathSync(p);
  const stat = fs.statSync(real);
  if (stat.size > MAX) {
    throw new Error(`ไฟล์ใหญ่เกิน ${Math.floor(stat.size / 1024)} KB (limit 512KB)`);
  }
  const buf = fs.readFileSync(real);
  // rough binary check: NUL byte in first 8KB
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) throw new Error("ไฟล์ binary — รองรับเฉพาะ text");
  return buf.toString("utf8"); // tolerant of stray bytes via replacement
}

// Write text to a file (used to attach docs into {projectDir}/docs/). mkdir -p parent.
export function writeFileText(p: string, content: string): void {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}
