export type HerdrResult = { code: number; stdout: string; stderr: string };
export type HerdrCli = (args: string[]) => Promise<HerdrResult>;

// Every Herdr call is bounded: a wedged server must not hold the watcher tick forever.
export const herdrCli = (bin = process.env.HERDR_BIN ?? "herdr", timeoutMs = 15_000): HerdrCli => async (args) => {
  const child = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
};

export class HerdrOutputError extends Error {}

// Herdr sometimes prints a human line in front of its JSON (a notice around a model switch was seen
// in production). Take the first "{" through the last "}" rather than failing the whole tick.
export function safeJsonFromCli<T>(stdout: string): T {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(stdout.slice(start, end + 1)) as T; } catch { /* fall through */ }
  }
  throw new HerdrOutputError(`herdr output is not JSON: ${stdout.slice(0, 200).replace(/\s+/g, " ")}`);
}

export type HerdrAgent = {
  pane_id: string;
  tab_id?: string;
  agent?: string;
  display_agent?: string;
  agent_status: string;
  status_since_unix_ms?: number;
  cwd?: string;
  foreground_cwd?: string;
  terminal_title_stripped?: string;
};

export async function listAgents(cli: HerdrCli): Promise<HerdrAgent[]> {
  const got = await cli(["agent", "list"]);
  if (got.code !== 0) throw new Error(`herdr agent list failed (exit ${got.code})`);
  return safeJsonFromCli<{ result?: { agents?: HerdrAgent[] } }>(got.stdout).result?.agents ?? [];
}

export async function readPane(cli: HerdrCli, paneId: string): Promise<string> {
  const got = await cli(["agent", "read", paneId]);
  if (got.code !== 0) throw new Error(`herdr agent read failed (exit ${got.code})`);
  return got.stdout;
}

// Bracketed paste keeps a multi-line answer one submission; ESC is stripped so the answer can never
// end the paste early or inject terminal control sequences.
export function pasteText(text: string): string {
  return `\u001b[200~${text.replace(/\u001b/g, "")}\u001b[201~`;
}

// The one and only injection path: paste the answer, then press Enter.
export async function injectAnswer(cli: HerdrCli, paneId: string, text: string): Promise<void> {
  const sent = await cli(["pane", "send-text", paneId, pasteText(text)]);
  if (sent.code !== 0) throw new Error(`herdr send-text failed (exit ${sent.code})`);
  const enter = await cli(["pane", "send-keys", paneId, "enter"]);
  if (enter.code !== 0) throw new Error(`herdr send-keys failed (exit ${enter.code})`);
}
