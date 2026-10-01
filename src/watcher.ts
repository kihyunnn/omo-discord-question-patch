import type { HerdrCli } from "./herdr.ts";
import { injectAnswer, listAgents, readPane } from "./herdr.ts";
import { parsePaneQuestions, parseQuestionCallback, parseSessionQuestionCalls, questionText, type ParsedQuestions } from "./questions.ts";
import { readSessionTailForCwd } from "./session-lookup.ts";
import type { PendingQuestion, QuestionOrigin, QuestionStore } from "./store.ts";

export type ChatPort = {
  sendQuestion(origin: QuestionOrigin, text: string, questions: ParsedQuestions["questions"]): Promise<string[]>;
  editQuestion(origin: QuestionOrigin, messageIds: string[], text: string, questions: ParsedQuestions["questions"] | null, answered: Record<number, string>): Promise<void>;
};

export type WatcherDeps = {
  cli: HerdrCli;
  store: QuestionStore;
  chat: ChatPort;
  origin: QuestionOrigin;
  sessionRoot?: string;
  log?: (line: string) => void;
  now?: () => number;
};

export type PressOutcome = "answered" | "ignored" | "not_owner";

type Live = PendingQuestion & { paneStatus: string; awaitingTextFor: number | null };

// The watcher is the whole runtime: one tick finds blocked Herdr panes, posts their question as chat
// buttons, and a press injects the answer back into that pane. It is Herdr-only on purpose — Herdr
// supplies the blocked/idle state, the pane text, and the send-text/send-keys injection primitive.
export class QuestionWatcher {
  private readonly pending = new Map<string, Live>();
  private readonly byMessage = new Map<string, string>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: WatcherDeps) {
    this.log = deps.log ?? (() => {});
    for (const row of deps.store.loadPending()) {
      this.pending.set(row.key, { ...row, paneStatus: "unknown", awaitingTextFor: null });
      for (const id of row.messageIds) this.byMessage.set(`${row.origin.platform === "discord" ? row.origin.channelId : row.origin.chatId}:${id}`, row.key);
    }
  }

  pendingCount(): number { return this.pending.size; }

  // One tick. Returns how many questions were newly posted.
  async tick(): Promise<number> {
    const agents = await listAgents(this.deps.cli);
    let posted = 0;

    // A pane that is working again resolves its question: the buttons must stop accepting answers.
    for (const agent of agents.filter((a) => a.agent_status === "working" || a.agent_status === "idle")) {
      const live = this.pending.get(agent.pane_id);
      if (live) await this.invalidate(live, "✅ The session is running again, so this question was closed.");
    }

    for (const agent of agents.filter((a) => a.agent_status === "blocked")) {
      if (this.pending.has(agent.pane_id)) continue;
      const episodeKey = `${agent.pane_id}:${agent.status_since_unix_ms ?? 0}`;
      const fresh = this.deps.store.beginEpisode(episodeKey);
      const cwd = agent.cwd ?? agent.foreground_cwd ?? "";
      const sessionLog = cwd ? readSessionTailForCwd(cwd, undefined, this.deps.sessionRoot) : "";
      const parsed = parseSessionQuestionCalls(sessionLog) ?? await this.parsePaneFallback(agent.pane_id);
      if (!parsed) {
        // The question may not be in the log yet (the tick can land between the blocked state and the
        // tool call). Keeping the episode row would swallow it for good, so clear it and retry next tick.
        this.deps.store.clearEpisode(episodeKey);
        if (fresh) this.log(`QUESTION_NOT_PARSED_YET pane=${agent.pane_id} (will retry)`);
        continue;
      }
      if (!fresh) continue;
      const origin = this.deps.origin;
      const live: Live = { key: agent.pane_id, paneId: agent.pane_id, sessionId: null, parsed, messageIds: [], origin, answered: {}, paneStatus: "blocked", awaitingTextFor: null };
      try {
        await this.publish(live);
        posted += 1;
      } catch (error) {
        // A failed post must not consume the episode, or the question disappears after one transient
        // platform error. Clearing the episode row lets the next tick try again.
        this.pending.delete(live.key);
        this.deps.store.clearEpisode(episodeKey);
        this.log(`QUESTION_POST_FAILED pane=${agent.pane_id} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return posted;
  }

  // Pane text is only the fallback: the primary source is the session log.
  private async parsePaneFallback(paneId: string): Promise<ParsedQuestions | null> {
    try { return parsePaneQuestions(await readPane(this.deps.cli, paneId)); } catch { return null; }
  }

  private async publish(live: Live): Promise<void> {
    const text = `⏸ ${questionText(live.parsed)}\n\nWaiting for the owner to choose.`;
    live.messageIds = await this.deps.chat.sendQuestion(live.origin, text, live.parsed.questions);
    for (const id of live.messageIds) this.byMessage.set(`${live.origin.platform === "discord" ? live.origin.channelId : live.origin.chatId}:${id}`, live.key);
    this.pending.set(live.key, live);
    this.deps.store.save(live);
    this.log(`QUESTION_POSTED pane=${live.paneId} messages=${live.messageIds.length} questions=${live.parsed.questions.length}`);
  }

  private async invalidate(live: Live, text: string): Promise<void> {
    await this.deps.chat.editQuestion(live.origin, live.messageIds, text, null, {}).catch(() => {});
    this.forget(live);
  }

  private forget(live: Live): void {
    const chatId = live.origin.platform === "discord" ? live.origin.channelId : live.origin.chatId;
    for (const id of live.messageIds) this.byMessage.delete(`${chatId}:${id}`);
    this.pending.delete(live.key);
    this.deps.store.forget(live.key);
  }

  // A typed answer from a modal, identified by the pending question's key rather than a message.
  async pressTyped(input: { key: string; authorId: string; ownerId: string; answer: string }): Promise<PressOutcome> {
    if (input.authorId !== input.ownerId) return "not_owner";
    const live = this.pending.get(input.key);
    if (!live || input.answer === "") return "ignored";
    await this.answer(live, live.awaitingTextFor ?? 0, input.answer);
    live.awaitingTextFor = null;
    return "answered";
  }

  // A button press. `answerText` is set when the press came from a typed answer rather than an option.
  async press(input: { platform: "discord" | "telegram"; chatId: string; messageId: string; authorId: string; ownerId: string; customId: string; answerText?: string }): Promise<PressOutcome> {
    if (input.authorId !== input.ownerId) return "not_owner";
    const key = this.byMessage.get(`${input.chatId}:${input.messageId}`);
    const live = key ? this.pending.get(key) : undefined;
    if (!live) return "ignored";
    const choice = parseQuestionCallback(input.customId, "q");
    if (!choice || choice.questionIndex >= live.parsed.questions.length) return "ignored";
    if (live.answered[choice.questionIndex] !== undefined) return "ignored";
    if (choice.write) { live.awaitingTextFor = choice.questionIndex; this.deps.store.save(live); return "answered"; }
    const question = live.parsed.questions[choice.questionIndex]!;
    const answer = input.answerText ?? question.options[choice.optionIndex ?? -1]?.value;
    if (answer === undefined || answer === "") return "ignored";
    await this.answer(live, choice.questionIndex, answer);
    return "answered";
  }

  private async answer(live: Live, questionIndex: number, answer: string): Promise<void> {
    live.answered[questionIndex] = answer;
    await injectAnswer(this.deps.cli, live.paneId, answer);
    const total = live.parsed.questions.length;
    if (Object.keys(live.answered).length >= total) {
      await this.deps.chat.editQuestion(live.origin, live.messageIds, `✅ The owner answered every question.\n${this.summary(live)}`, null, live.answered).catch(() => {});
      this.forget(live);
      return;
    }
    this.deps.store.save(live);
    // Only the answered question's buttons are disabled; the rest stay clickable.
    await this.deps.chat.editQuestion(live.origin, live.messageIds, `⏸ ${this.summary(live)}\n\n${total - Object.keys(live.answered).length} question(s) left.`, live.parsed.questions, live.answered).catch(() => {});
  }

  private summary(live: Live): string {
    return live.parsed.questions.map((question, qi) => `${qi + 1}. ${question.text} → ${live.answered[qi] ?? "(unanswered)"}`).join("\n");
  }
}
