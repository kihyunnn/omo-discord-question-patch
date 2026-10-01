import type { PaneQuestion } from "./questions.ts";

export type TelegramButton = { text: string; callback_data: string };

// Telegram inline keyboards have no disabled state, so an answered question collapses to a single
// "✅ <answer>" row while the remaining questions keep their live buttons.
export function telegramQuestionRows(questions: PaneQuestion[], answered: Record<number, string> = {}): TelegramButton[][] {
  return questions.flatMap((question, qi) => {
    const chosen = answered[qi];
    if (chosen !== undefined) return [[{ text: `✅ ${chosen}`.slice(0, 64), callback_data: `q|${qi}|a` }]];
    return question.options
      .map((choice, oi) => [{ text: `${question.multiSelect ? "☐ " : ""}${choice.label}`.slice(0, 64), callback_data: `q|${qi}|${oi}` }])
      .concat([[{ text: "✍ Write your own", callback_data: `q|${qi}|w` }]]);
  });
}

export type TelegramQuestionPort = {
  sendQuestion(chatId: string, text: string, questions: PaneQuestion[], options: { replyTo?: string; threadId?: string }): Promise<string>;
  editQuestion(chatId: string, messageId: string, text: string, questions: PaneQuestion[] | null, answered: Record<number, string>): Promise<void>;
};

export function createTelegramPort(token: string, fetcher: typeof fetch = fetch): TelegramQuestionPort {
  const call = async (method: string, body: unknown): Promise<{ ok?: boolean; description?: string; result?: { message_id?: number } }> => {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const parsed = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!parsed.ok) throw new Error(`telegram ${method} ${response.status} ${parsed.description ?? ""}`);
    return parsed;
  };
  const thread = (threadId?: string) => (threadId === undefined ? {} : { message_thread_id: Number(threadId) });
  return {
    async sendQuestion(chatId, text, questions, options) {
      const body = await call("sendMessage", {
        chat_id: Number(chatId), text,
        reply_markup: { inline_keyboard: telegramQuestionRows(questions) },
        ...thread(options.threadId),
        ...(options.replyTo === undefined ? {} : { reply_parameters: { message_id: Number(options.replyTo), allow_sending_without_reply: true } }),
      });
      if (body.result?.message_id === undefined) throw new Error("telegram sendQuestion returned no message id");
      return String(body.result.message_id);
    },
    async editQuestion(chatId, messageId, text, questions, answered) {
      await call("editMessageText", {
        chat_id: Number(chatId), message_id: Number(messageId), text,
        reply_markup: { inline_keyboard: questions === null ? [] : telegramQuestionRows(questions, answered) },
      });
    },
  };
}
