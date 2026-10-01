import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the agent keeps its engine state, mirrored from the runtime's own agent-dir module so the
// same session logs are read on every OS. A bare join(os.homedir(), ".omo/agent/sessions") breaks on
// Windows (the runtime may write under $HOME, e.g. AppData\Roaming, not %USERPROFILE%) and ignores a
// pinned state directory.
export const AGENT_DIR_ENV_NAMES = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const;

export function runtimeHome(env: Record<string, string | undefined> = process.env, fallback: string = homedir()): string {
  return env.HOME || env.USERPROFILE || fallback;
}

export function agentDir(env: Record<string, string | undefined> = process.env, fallback: string = homedir()): string {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim();
    if (configured) return resolve(configured);
  }
  return join(runtimeHome(env, fallback), ".omo", "agent");
}

export function sessionRoot(env: Record<string, string | undefined> = process.env, fallback: string = homedir()): string {
  return join(agentDir(env, fallback), "sessions");
}

// A blocked question is always near the end of the log, and these files reach tens of MB. Reading
// the whole file synchronously blocked the event loop long enough to miss Discord's 3-second ack
// window, so only the tail is read.
export const QUESTION_LOG_BYTES = 512 * 1024;

export function newestSessionFile(sessionId: string, root: string): string | null {
  let newest: { path: string; mtime: number } | null = null;
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    let files: string[];
    try { files = readdirSync(join(root, dir)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(`_${sessionId}.jsonl`)) continue;
      const path = join(root, dir, file);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  }
  return newest?.path ?? null;
}

// A positional read of the last `bytes` bytes. The session id is validated by the caller; a missing
// log is an empty tail, never a throw, so one unreadable session cannot stop the tick.
export function readSessionTail(sessionId: string, bytes: number = QUESTION_LOG_BYTES, root: string = sessionRoot()): string {
  const path = newestSessionFile(sessionId, root);
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
