import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { QUESTION_LOG_BYTES, sessionRoot } from "./session-log.ts";

// omo names a session directory after the project path: every separator becomes "-" and the whole
// slug is wrapped in "--". So a pane's cwd identifies its session directory without needing a
// session id, which Herdr does not expose.
export function sessionDirSlug(cwd: string): string {
  const normalized = cwd.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return `--${normalized.replaceAll("/", "-")}--`;
}

export function newestSessionFileForCwd(cwd: string, root: string = sessionRoot()): string | null {
  const dir = join(root, sessionDirSlug(cwd));
  let files: string[];
  try { files = readdirSync(dir); } catch { return null; }
  let newest: { path: string; mtime: number } | null = null;
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest?.path ?? null;
}

// The same bounded positional read as the session-id path, keyed by cwd instead.
export function readSessionTailForCwd(cwd: string, bytes: number = QUESTION_LOG_BYTES, root: string = sessionRoot()): string {
  const path = newestSessionFileForCwd(cwd, root);
  if (!path) return "";
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return buffer.toString("utf8");
  } catch { return ""; }
}
