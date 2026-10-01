import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDiscordChat, createTelegramChat } from "./chat.ts";
import { loadConfig } from "./config.ts";
import { createDiscordPort } from "./discord.ts";
import { herdrCli } from "./herdr.ts";
import { startDiscordInteractions, startTelegramPolling } from "./inbound.ts";
import { QuestionStore, type QuestionOrigin } from "./store.ts";
import { createTelegramPort } from "./telegram.ts";
import { QuestionWatcher } from "./watcher.ts";

// Herdr-only reference runtime: one tick finds blocked panes, posts the question as chat buttons, and
// a press injects the answer into the pane with send-text + send-keys enter.
//
//   QUESTION_PATCH_CONFIG=~/.config/omo-question-patch/config.json bun run src/main.ts
//
// Inbound presses arrive over HTTP (Discord interactions) or long polling (Telegram); this entrypoint
// runs the watcher loop and hands presses to the same watcher instance.
async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(dirname(config.stateFile), { recursive: true });
  const store = new QuestionStore(config.stateFile);
  const cli = herdrCli(config.herdrBin);

  const chat = config.discord
    ? createDiscordChat(createDiscordPort(config.discord.token))
    : createTelegramChat(createTelegramPort(config.telegram!.token));
  const origin: QuestionOrigin = config.discord
    ? { platform: "discord", channelId: config.discord.channelId }
    : { platform: "telegram", chatId: config.telegram!.chatId, threadId: config.telegram!.threadId ?? null };

  const watcher = new QuestionWatcher({ cli, store, chat, origin, log: (line) => console.log(line) });

  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());

  const inbound = config.discord?.publicKey && config.discord.port
    ? startDiscordInteractions({ port: config.discord.port, publicKeyHex: config.discord.publicKey, ownerId: config.discord.ownerId, ...(config.discord.guildId ? { guildId: config.discord.guildId } : {}), watcher })
    : config.telegram
      ? startTelegramPolling({ token: config.telegram.token, ownerId: config.telegram.ownerId, watcher })
      : null;

  console.log(`omo-question-patch: watching Herdr for blocked panes every ${config.intervalMs}ms (${origin.platform})`);
  while (!stop.signal.aborted) {
    try { await watcher.tick(); } catch (error) { console.log(`TICK_FAILED ${error instanceof Error ? error.message : String(error)}`); }
    await Bun.sleep(config.intervalMs);
  }
  inbound?.stop();
  store.close();
}

if (import.meta.main) await main();
