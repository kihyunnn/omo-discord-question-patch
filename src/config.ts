import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DiscordConfig = { token: string; channelId: string; ownerId: string; guildId?: string; publicKey?: string; port?: number };
export type TelegramConfig = { token: string; chatId: string; ownerId: string; threadId?: string };

export type Config = {
  herdrBin: string;
  intervalMs: number;
  stateFile: string;
  discord?: DiscordConfig;
  telegram?: TelegramConfig;
};

type FileShape = {
  herdr_bin?: string;
  interval_ms?: number;
  state_file?: string;
  discord?: { token?: string; channel_id?: string; owner_id?: string; guild_id?: string; public_key?: string; port?: number };
  telegram?: { token?: string; chat_id?: string; owner_id?: string; thread_id?: string };
};

export class ConfigError extends Error {}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

// Configuration comes from a JSON file and/or the environment; the environment wins so a token can
// stay out of the file. Only the fields a question bot needs are read.
export function loadConfig(filePath: string = process.env.QUESTION_PATCH_CONFIG ?? join(homedir(), ".config", "omo-question-patch", "config.json")): Config {
  let file: FileShape = {};
  try { file = JSON.parse(readFileSync(filePath, "utf8")) as FileShape; } catch { file = {}; }

  const discordToken = env("DISCORD_BOT_TOKEN") ?? file.discord?.token;
  const discordChannel = env("DISCORD_CHANNEL_ID") ?? file.discord?.channel_id;
  const discordOwner = env("DISCORD_OWNER_ID") ?? file.discord?.owner_id;
  const telegramToken = env("TELEGRAM_BOT_TOKEN") ?? file.telegram?.token;
  const telegramChat = env("TELEGRAM_CHAT_ID") ?? file.telegram?.chat_id;
  const telegramOwner = env("TELEGRAM_OWNER_ID") ?? file.telegram?.owner_id;

  const config: Config = {
    herdrBin: env("HERDR_BIN") ?? file.herdr_bin ?? "herdr",
    intervalMs: Number(env("QUESTION_PATCH_INTERVAL_MS") ?? file.interval_ms ?? 10_000),
    stateFile: env("QUESTION_PATCH_STATE") ?? file.state_file ?? join(homedir(), ".local", "state", "omo-question-patch", "state.sqlite"),
    ...(discordToken && discordChannel && discordOwner
      ? {
        discord: {
          token: discordToken, channelId: discordChannel, ownerId: discordOwner,
          ...(env("DISCORD_GUILD_ID") ?? file.discord?.guild_id ? { guildId: env("DISCORD_GUILD_ID") ?? file.discord?.guild_id } : {}),
          // The interactions endpoint needs the app's Ed25519 public key and a port to listen on.
          ...(env("DISCORD_PUBLIC_KEY") ?? file.discord?.public_key ? { publicKey: env("DISCORD_PUBLIC_KEY") ?? file.discord?.public_key } : {}),
          ...(Number(env("DISCORD_PORT") ?? file.discord?.port ?? 0) > 0 ? { port: Number(env("DISCORD_PORT") ?? file.discord?.port) } : {}),
        },
      }
      : {}),
    ...(telegramToken && telegramChat && telegramOwner
      ? { telegram: { token: telegramToken, chatId: telegramChat, ownerId: telegramOwner, ...(env("TELEGRAM_THREAD_ID") ?? file.telegram?.thread_id ? { threadId: env("TELEGRAM_THREAD_ID") ?? file.telegram?.thread_id } : {}) } }
      : {}),
  };

  if (!config.discord && !config.telegram) {
    throw new ConfigError(`no chat platform configured: set DISCORD_BOT_TOKEN/DISCORD_CHANNEL_ID/DISCORD_OWNER_ID or the Telegram equivalents (config file: ${filePath})`);
  }
  return config;
}
