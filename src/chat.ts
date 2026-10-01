import { chunkQuestionRows, chunkQuestionText, createDiscordPort, discordQuestionRows, type DiscordQuestionPort } from "./discord.ts";
import type { PaneQuestion } from "./questions.ts";
import { createTelegramPort, type TelegramQuestionPort } from "./telegram.ts";
import type { ChatPort } from "./watcher.ts";
import type { QuestionOrigin } from "./store.ts";

// The chat side of the watcher: one adapter per platform, both presenting the same send/edit shape so
// the watcher never branches on platform.
export function createDiscordChat(port: DiscordQuestionPort, opts: { replyTo?: string } = {}): ChatPort {
  return {
    async sendQuestion(origin, text, questions) {
      if (origin.platform !== "discord") throw new Error("discord chat got a non-discord origin");
      return port.sendQuestion(origin.channelId, text, questions, opts.replyTo);
    },
    async editQuestion(origin, messageIds, text, questions, answered) {
      if (origin.platform !== "discord") throw new Error("discord chat got a non-discord origin");
      // Each posted message shows only its own chunk of rows; the row layout is stable across edits,
      // so the chunk index identifies which message to patch.
      for (const [index, id] of messageIds.entries()) {
        await port.editQuestion(origin.channelId, id, index === 0 ? text : `⏸ (continued)\n${questions ? chunkQuestionText(questions, chunkQuestionRows(discordQuestionRows(questions, answered))[index] ?? []) : ""}`, questions, answered, index).catch(() => {});
      }
    },
  };
}

export function createTelegramChat(port: TelegramQuestionPort, opts: { threadId?: string } = {}): ChatPort {
  return {
    async sendQuestion(origin, text, questions) {
      if (origin.platform !== "telegram") throw new Error("telegram chat got a non-telegram origin");
      const id = await port.sendQuestion(origin.chatId, text, questions, {
        ...(origin.threadId === null ? {} : { threadId: origin.threadId }),
        ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
      });
      return [id];
    },
    async editQuestion(origin, messageIds, text, questions, answered) {
      if (origin.platform !== "telegram") throw new Error("telegram chat got a non-telegram origin");
      for (const id of messageIds) await port.editQuestion(origin.chatId, id, text, questions, answered).catch(() => {});
    },
  };
}

export type { PaneQuestion };
