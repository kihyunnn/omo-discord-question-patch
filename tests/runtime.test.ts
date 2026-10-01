import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkQuestionRows, DISCORD_QUESTION_ROW_LIMIT, discordQuestionRows, DISCORD_OPTIONS_PER_ROW } from "../src/discord.ts";
import type { HerdrCli, HerdrResult } from "../src/herdr.ts";
import { injectAnswer, pasteText, safeJsonFromCli } from "../src/herdr.ts";
import { parsePaneQuestions, parseSessionQuestionCalls } from "../src/questions.ts";
import { newestSessionFileForCwd, readSessionTailForCwd, sessionDirSlug } from "../src/session-lookup.ts";
import { QuestionStore } from "../src/store.ts";
import { telegramQuestionRows } from "../src/telegram.ts";
import { QuestionWatcher, type ChatPort } from "../src/watcher.ts";

const questionCall = (text: string, options: string[]) => JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", arguments: { questions: [{ question: text, options: options.map((label) => ({ label })) }] } }] },
});

// A fake Herdr: a scriptable agent list, captured send-text/send-keys, and pane text.
function fakeHerdr(state: { agents: { pane_id: string; agent_status: string; status_since_unix_ms?: number; cwd?: string }[]; paneText?: string }) {
  const sent: string[][] = [];
  const cli: HerdrCli = async (args): Promise<HerdrResult> => {
    if (args[0] === "agent" && args[1] === "list") return { code: 0, stdout: JSON.stringify({ result: { agents: state.agents } }), stderr: "" };
    if (args[0] === "agent" && args[1] === "read") return { code: 0, stdout: state.paneText ?? "", stderr: "" };
    if (args[0] === "pane" && args[1] === "send-text") { sent.push(["send-text", args[2]!, args[3]!]); return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "pane" && args[1] === "send-keys") { sent.push(["send-keys", args[2]!, args[3]!]); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "" };
  };
  return { cli, sent };
}

// A fake chat that records what would be posted and edited.
function fakeChat() {
  const posted: { text: string; rows: number }[] = [];
  const edits: { text: string; answered: Record<number, string>; questions: number }[] = [];
  let counter = 0;
  const chat: ChatPort = {
    async sendQuestion(_origin, text, questions) {
      posted.push({ text, rows: discordQuestionRows(questions).length });
      return [String(++counter)];
    },
    async editQuestion(_origin, _ids, text, questions, answered) {
      edits.push({ text, answered, questions: questions ? questions.length : 0 });
    },
  };
  return { chat, posted, edits };
}

const tempRoot = (cwd: string, sessionId: string, body: string) => {
  const root = mkdtempSync(join(tmpdir(), "omoqp-"));
  const dir = join(root, sessionDirSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-10-01T00-00-00-000Z_${sessionId}.jsonl`), body);
  return root;
};

test("a blocked pane's question is posted as buttons and the answer is injected into that pane", async () => {
  const cwd = "/srv/app";
  const root = tempRoot(cwd, "session-a", `${questionCall("Deploy to which environment?", ["staging", "production"])}\n`);
  const store = new QuestionStore(":memory:");
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p1", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  const watcher = new QuestionWatcher({ cli: herdr.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });

  expect(await watcher.tick()).toBe(1);
  expect(chat.posted).toHaveLength(1);
  expect(chat.posted[0]!.text).toContain("Deploy to which environment?");
  expect(chat.posted[0]!.rows).toBe(1);

  const outcome = await watcher.press({ platform: "discord", chatId: "chan", messageId: "1", authorId: "owner", ownerId: "owner", customId: "q|0|1" });
  expect(outcome).toBe("answered");
  expect(herdr.sent).toEqual([["send-text", "wE:p1", pasteText("production")], ["send-keys", "wE:p1", "enter"]]);
  expect(chat.edits.at(-1)!.text).toContain("answered every question");
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("only the newest question call is posted, so an answered question is not reposted", async () => {
  const cwd = "/srv/two";
  const body = [questionCall("round one?", ["A", "B"]), questionCall("round two?", ["C", "D"])].join("\n");
  const root = tempRoot(cwd, "session-b", `${body}\n`);
  const store = new QuestionStore(":memory:");
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p2", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  const watcher = new QuestionWatcher({ cli: herdr.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  await watcher.tick();
  expect(chat.posted).toHaveLength(1);
  expect(chat.posted[0]!.text).toContain("round two?");
  expect(chat.posted[0]!.text).not.toContain("round one?");
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("a multi-question set is split across messages, never truncated", () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({ text: `q${i}?`, multiSelect: false, options: [{ label: "a", value: "a" }, { label: "b", value: "b" }] }));
  const rows = discordQuestionRows(questions);
  expect(rows).toHaveLength(6);
  const chunks = chunkQuestionRows(rows);
  expect(chunks).toHaveLength(2);
  expect(chunks.every((chunk) => chunk.length <= DISCORD_QUESTION_ROW_LIMIT)).toBe(true);
  expect(chunks.flat()).toHaveLength(rows.length);
});

test("options pack up to 5 per action row, so a wide question does not waste rows", () => {
  const questions = [{ text: "many?", multiSelect: false, options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}`, value: `o${i}` })) }];
  const rows = discordQuestionRows(questions);
  // 7 options + the write button = 8 buttons -> 5 + 3 across two rows.
  expect(rows).toHaveLength(2);
  expect(rows[0]!.row.components).toHaveLength(5);
  expect(rows[1]!.row.components).toHaveLength(3);
});

test("a partial answer disables only the answered question and keeps the rest clickable", async () => {
  const cwd = "/srv/three";
  const call = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", arguments: { questions: [
    { question: "first?", options: [{ label: "a1" }, { label: "b1" }] },
    { question: "second?", options: [{ label: "a2" }, { label: "b2" }] },
  ] } }] } });
  const root = tempRoot(cwd, "session-c", `${call}\n`);
  const store = new QuestionStore(":memory:");
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p3", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  const watcher = new QuestionWatcher({ cli: herdr.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  await watcher.tick();
  await watcher.press({ platform: "discord", chatId: "chan", messageId: "1", authorId: "owner", ownerId: "owner", customId: "q|0|0" });

  const questions = parseSessionQuestionCalls(`${call}\n`)!.questions;
  const answeredRows = discordQuestionRows(questions, { 0: "a1" });
  const first = answeredRows.filter((row) => row.questionIndex === 0).flatMap((row) => row.row.components);
  const second = answeredRows.filter((row) => row.questionIndex === 1).flatMap((row) => row.row.components);
  expect(first.every((button) => button.disabled === true)).toBe(true);
  expect(second.every((button) => button.disabled !== true)).toBe(true);
  expect(herdr.sent).toHaveLength(2);
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("a non-owner press is refused and injects nothing", async () => {
  const cwd = "/srv/owner";
  const root = tempRoot(cwd, "session-d", `${questionCall("who?", ["me", "you"])}\n`);
  const store = new QuestionStore(":memory:");
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p4", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  const watcher = new QuestionWatcher({ cli: herdr.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  await watcher.tick();
  const outcome = await watcher.press({ platform: "discord", chatId: "chan", messageId: "1", authorId: "someone-else", ownerId: "owner", customId: "q|0|0" });
  expect(outcome).toBe("not_owner");
  expect(herdr.sent).toHaveLength(0);
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("a pane that is working again invalidates its question", async () => {
  const cwd = "/srv/resume";
  const root = tempRoot(cwd, "session-e", `${questionCall("still waiting?", ["yes", "no"])}\n`);
  const store = new QuestionStore(":memory:");
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p5", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  const watcher = new QuestionWatcher({ cli: herdr.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  await watcher.tick();
  expect(watcher.pendingCount()).toBe(1);
  const resumed = fakeHerdr({ agents: [{ pane_id: "wE:p5", agent_status: "working", status_since_unix_ms: 2, cwd }] });
  const watcher2 = new QuestionWatcher({ cli: resumed.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  await watcher2.tick();
  expect(watcher2.pendingCount()).toBe(0);
  expect(chat.edits.at(-1)!.questions).toBe(0);
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("a pending question survives a restart", async () => {
  const cwd = "/srv/restart";
  const root = tempRoot(cwd, "session-f", `${questionCall("persisted?", ["yes", "no"])}\n`);
  const file = join(mkdtempSync(join(tmpdir(), "omoqp-db-")), "state.sqlite");
  const first = new QuestionStore(file);
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p6", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  await new QuestionWatcher({ cli: herdr.cli, store: first, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root }).tick();
  first.close();

  const reopened = new QuestionStore(file);
  const restarted = new QuestionWatcher({ cli: herdr.cli, store: reopened, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  expect(restarted.pendingCount()).toBe(1);
  expect(await restarted.press({ platform: "discord", chatId: "chan", messageId: "1", authorId: "owner", ownerId: "owner", customId: "q|0|0" })).toBe("answered");
  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

test("a question not yet in the log is retried on the next tick", async () => {
  const cwd = "/srv/late";
  const root = tempRoot(cwd, "session-g", "{\"type\":\"message\"}\n");
  const store = new QuestionStore(":memory:");
  const herdr = fakeHerdr({ agents: [{ pane_id: "wE:p7", agent_status: "blocked", status_since_unix_ms: 1, cwd }] });
  const chat = fakeChat();
  const watcher = new QuestionWatcher({ cli: herdr.cli, store, chat: chat.chat, origin: { platform: "discord", channelId: "chan" }, sessionRoot: root });
  expect(await watcher.tick()).toBe(0);
  expect(watcher.pendingCount()).toBe(0);
  writeFileSync(join(root, sessionDirSlug(cwd), "2026-10-01T00-00-01-000Z_session-g2.jsonl"), `${questionCall("now it is here?", ["ok"])}\n`);
  expect(await watcher.tick()).toBe(1);
  expect(chat.posted).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
  store.close();
});

test("telegram folds an answered question instead of disabling every button", () => {
  const questions = [
    { text: "first?", multiSelect: false, options: [{ label: "a1", value: "a1" }, { label: "b1", value: "b1" }] },
    { text: "second?", multiSelect: false, options: [{ label: "a2", value: "a2" }, { label: "b2", value: "b2" }] },
  ];
  const rows = telegramQuestionRows(questions, { 0: "a1" });
  expect(rows[0]![0]!.text).toBe("✅ a1");
  expect(rows.slice(1).flat().map((button) => button.text)).toEqual(["a2", "b2", "✍ Write your own"]);
});

test("the session log is found from a pane's cwd, by the directory-slug rule", () => {
  expect(sessionDirSlug("/home/u/app")).toBe("--home-u-app--");
  expect(sessionDirSlug("C:\\Users\\u\\app")).toBe("--C:-Users-u-app--".replace("C:", "C:"));
  const root = tempRoot("/home/u/proj", "s1", `${questionCall("by cwd?", ["x"])}\n`);
  const file = newestSessionFileForCwd("/home/u/proj", root);
  expect(file).toContain("_s1.jsonl");
  expect(parseSessionQuestionCalls(readSessionTailForCwd("/home/u/proj", 512 * 1024, root))!.questions[0]!.text).toBe("by cwd?");
  rmSync(root, { recursive: true, force: true });
});

test("herdr JSON is extracted even with a stray line in front, and the tail read is positional", () => {
  expect(safeJsonFromCli<{ a: number }>("notice\n{\"a\":1}\n")).toEqual({ a: 1 });
  expect(() => safeJsonFromCli("no json here")).toThrow();
  const dir = mkdtempSync(join(tmpdir(), "omoqp-tail-"));
  const path = join(dir, "big.jsonl");
  writeFileSync(path, "HEAD_MARKER\n" + "x".repeat(2 * 1024 * 1024) + "\n" + questionCall("at the end?", ["y"]) + "\n");
  const tail = readSessionTailForCwd("/nope", 64 * 1024, join(dir, ".."));
  expect(tail).not.toContain("HEAD_MARKER");
  rmSync(dir, { recursive: true, force: true });
});

test("injection is a bracketed paste followed by Enter", async () => {
  const calls: string[][] = [];
  const cli: HerdrCli = async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  await injectAnswer(cli, "wE:p9", "line one\nline two");
  expect(calls[0]![0]).toBe("pane");
  expect(calls[0]![1]).toBe("send-text");
  expect(calls[0]![3]).toBe("\u001b[200~line one\nline two\u001b[201~");
  expect(calls[1]!.slice(0, 3)).toEqual(["pane", "send-keys", "wE:p9"]);
  expect(calls[1]![3]).toBe("enter");
  expect(DISCORD_OPTIONS_PER_ROW).toBe(5);
});
