import type { PaneQuestion } from "./questions.ts";

export type QuestionButton = { type: 2; style: 1 | 2 | 3; label: string; custom_id: string; disabled?: boolean };
export type ActionRow = { type: 1; components: QuestionButton[] };
export type QuestionRow = { questionIndex: number; row: ActionRow };

export const DISCORD_OPTIONS_PER_ROW = 5;
export const DISCORD_QUESTION_ROW_LIMIT = 5;

// One row per 5 options, plus a "write your own" row. An answered question keeps its rows so the
// message layout does not shift, but its buttons are disabled and the chosen option is marked.
export function discordQuestionRows(questions: PaneQuestion[], answered: Record<number, string> = {}): QuestionRow[] {
  const rows: QuestionRow[] = [];
  questions.forEach((question, qi) => {
    const chosen = answered[qi];
    const isAnswered = chosen !== undefined;
    const buttons: QuestionButton[] = question.options.map((choice, optionIndex) => {
      const picked = isAnswered && choice.value === chosen;
      return {
        type: 2, style: picked ? 3 : 1, label: `${picked ? "✅ " : ""}${question.multiSelect ? "☐ " : ""}${choice.label}`.slice(0, 80),
        custom_id: `q|${qi}|${optionIndex}`, ...(isAnswered ? { disabled: true } : {}),
      };
    });
    buttons.push({ type: 2, style: 2, label: isAnswered ? `✅ ${chosen}`.slice(0, 80) : "✍ Write your own", custom_id: `q|${qi}|w`, ...(isAnswered ? { disabled: true } : {}) });
    for (let start = 0; start < buttons.length; start += DISCORD_OPTIONS_PER_ROW) {
      rows.push({ questionIndex: qi, row: { type: 1, components: buttons.slice(start, start + DISCORD_OPTIONS_PER_ROW) } });
    }
  });
  return rows;
}

// Discord rejects a message with more than 5 action rows (error 50035) and fails the whole message.
// Rows are never discarded: a question with many options continues in the next message.
export function chunkQuestionRows(rows: QuestionRow[], limit = DISCORD_QUESTION_ROW_LIMIT): QuestionRow[][] {
  const chunks: QuestionRow[][] = [];
  let current: QuestionRow[] = [];
  for (const entry of rows) {
    if (current.length >= limit) { chunks.push(current); current = []; }
    current.push(entry);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function chunkQuestionText(questions: PaneQuestion[], chunk: QuestionRow[]): string {
  return [...new Set(chunk.map((entry) => entry.questionIndex))].map((qi) => questions[qi]!.text).join("\n");
}

// The modal that "✍ Write your own" opens. Its `custom_id` (`qwrite|<key>`) is the only thing that can
// identify the pending question on submit — a modal submit carries no `message`. The HTTP interactions
// endpoint sends this body as the interaction response; `openModal` sends the same body through the
// callback endpoint, so both paths cannot drift.
export function modalPayload(customId: string, title: string, label: string): { type: 9; data: { custom_id: string; title: string; components: unknown[] } } {
  return {
    type: 9,
    data: {
      custom_id: customId,
      title: title.slice(0, 45),
      components: [{ type: 1, components: [{ type: 4, custom_id: "answer", label: label.slice(0, 45), style: 2, required: true, max_length: 2000 }] }],
    },
  };
}

export type DiscordQuestionPort = {
  sendQuestion(channelId: string, text: string, questions: PaneQuestion[], replyTo?: string): Promise<string[]>;
  editQuestion(channelId: string, messageId: string, text: string, questions: PaneQuestion[] | null, answered: Record<number, string>, chunkIndex: number): Promise<void>;
  ack(interactionId: string, token: string, content?: string): Promise<void>;
  openModal(interactionId: string, token: string, customId: string, title: string, label: string): Promise<void>;
};

// Discord's interaction responses: type 6 acknowledges silently (this must go out inside 3 seconds),
// type 4 replies ephemerally, type 9 opens a modal.
export function createDiscordPort(token: string, fetcher: typeof fetch = fetch): DiscordQuestionPort {
  const auth = { authorization: `Bot ${token}`, "content-type": "application/json" };
  const callback = async (id: string, token2: string, body: unknown): Promise<void> => {
    const response = await fetcher(`https://discord.com/api/v10/interactions/${id}/${token2}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`discord interaction callback ${response.status}`);
  };
  return {
    async sendQuestion(channelId, text, questions, replyTo) {
      const chunks = chunkQuestionRows(discordQuestionRows(questions));
      const ids: string[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const content = index === 0 ? text : `⏸ (continued)\n${chunkQuestionText(questions, chunk)}`;
        const response = await fetcher(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ content: content.slice(0, 2000), components: chunk.map((entry) => entry.row), ...(index === 0 && replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}) }),
        });
        const sent = await response.json().catch(() => ({})) as { id?: string; code?: number };
        if (!response.ok || !sent.id) throw new Error(`discord sendQuestion ${response.status} ${sent.code ?? ""}`);
        ids.push(sent.id);
      }
      return ids;
    },
    async editQuestion(channelId, messageId, text, questions, answered, chunkIndex) {
      const components = questions === null ? [] : (chunkQuestionRows(discordQuestionRows(questions, answered))[chunkIndex] ?? []).map((entry) => entry.row);
      const response = await fetcher(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH", headers: auth, body: JSON.stringify({ content: text.slice(0, 2000), components }),
      });
      if (!response.ok) throw new Error(`discord editQuestion ${response.status}`);
    },
    ack: (id, token2, content) => callback(id, token2, content === undefined ? { type: 6 } : { type: 4, data: { content: content.slice(0, 2000), flags: 64 } }),
    openModal: (id, token2, customId, title, label) => callback(id, token2, modalPayload(customId, title, label)),
  };
}
