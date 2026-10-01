import { createPublicKey, verify } from "node:crypto";
import type { QuestionWatcher } from "./watcher.ts";

// Discord signs every interaction with Ed25519 over (timestamp + raw body); without this check the
// endpoint would accept forged button presses, so it is verified before anything else is read.
export function verifyDiscordSignature(input: { publicKeyHex: string; signature: string; timestamp: string; body: string }): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(input.publicKeyHex, "hex")]),
      format: "der", type: "spki",
    });
    return verify(null, Buffer.concat([Buffer.from(input.timestamp), Buffer.from(input.body)]), key, Buffer.from(input.signature, "hex"));
  } catch { return false; }
}

export type DiscordInteraction = {
  type: number;
  id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  message?: { id?: string; channel_id?: string };
  data?: { custom_id?: string; component_type?: number | string; components?: unknown[] };
};

// Discord interaction types: 1 PING, 3 MESSAGE_COMPONENT, 5 MODAL_SUBMIT.
export function isComponent(data: DiscordInteraction["data"]): boolean {
  const t = data?.component_type;
  return t === 2 || t === 3 || t === 4 || t === "2" || t === "3" || t === "4";
}

export function modalAnswer(components: unknown[] | undefined): string {
  const raw = JSON.stringify(components ?? []);
  const match = raw.match(/"value"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match?.[1]) return "";
  try { return (JSON.parse(`"${match[1]}"`) as string).trim(); } catch { return ""; }
}

export function startDiscordInteractions(input: {
  port: number;
  publicKeyHex: string;
  ownerId: string;
  guildId?: string;
  watcher: QuestionWatcher;
  log?: (line: string) => void;
}): { stop(): void } {
  const log = input.log ?? console.log;
  const server = Bun.serve({
    port: input.port,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/discord/interactions") return new Response("not found", { status: 404 });
      const body = await request.text();
      if (!verifyDiscordSignature({ publicKeyHex: input.publicKeyHex, signature: request.headers.get("x-signature-ed25519") ?? "", timestamp: request.headers.get("x-signature-timestamp") ?? "", body })) {
        return new Response("invalid request signature", { status: 401 });
      }
      const interaction = JSON.parse(body) as DiscordInteraction;
      if (interaction.type === 1) return Response.json({ type: 1 });

      const author = interaction.member?.user?.id ?? interaction.user?.id ?? "";
      const channelId = interaction.message?.channel_id ?? interaction.channel_id ?? "";
      const messageId = interaction.message?.id ?? "";
      const custom = interaction.data?.custom_id ?? "";

      if (interaction.type === 5) {
        // A modal submit carries the typed answer; the pending question is identified by the modal's
        // custom id (`qwrite|<key>`), since the modal has no message of its own.
        const key = custom.startsWith("qwrite|") ? custom.slice(7) : "";
        const answer = modalAnswer(interaction.data?.components);
        void input.watcher.pressTyped({ key, authorId: author, ownerId: input.ownerId, answer }).catch((error: unknown) => log(`MODAL_FAILED ${String(error)}`));
        return Response.json({ type: 6 });
      }

      if (isComponent(interaction.data) && custom.startsWith("q|")) {
        // The answer work happens after the response, so the 3-second ack window is never spent on it.
        void input.watcher.press({ platform: "discord", chatId: channelId, messageId, authorId: author, ownerId: input.ownerId, customId: custom })
          .catch((error: unknown) => log(`PRESS_FAILED ${String(error)}`));
        return Response.json({ type: 6 });
      }
      return Response.json({ type: 6 });
    },
  });
  log(`discord interactions listening on :${input.port}`);
  return { stop: () => void server.stop(true) };
}

type TelegramUpdate = {
  update_id: number;
  callback_query?: { id: string; data?: string; from?: { id?: number }; message?: { message_id?: number; chat?: { id?: number } } };
  message?: { chat?: { id?: number }; text?: string; message_thread_id?: number };
};

export function startTelegramPolling(input: {
  token: string;
  ownerId: string;
  watcher: QuestionWatcher;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}): { stop(): void } {
  const log = input.log ?? console.log;
  const fetcher = input.fetcher ?? fetch;
  let offset = 0;
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await fetcher(`https://api.telegram.org/bot${input.token}/getUpdates`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["callback_query", "message"] }),
        });
        const body = await response.json() as { ok?: boolean; result?: TelegramUpdate[] };
        for (const update of body.result ?? []) {
          offset = update.update_id + 1;
          const press = update.callback_query;
          if (!press?.data || !press.message?.chat) continue;
          await input.watcher.press({
            platform: "telegram", chatId: String(press.message.chat.id), messageId: String(press.message.message_id),
            authorId: String(press.from?.id ?? ""), ownerId: input.ownerId, customId: press.data,
          }).catch((error: unknown) => log(`PRESS_FAILED ${String(error)}`));
          await fetcher(`https://api.telegram.org/bot${input.token}/answerCallbackQuery`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: press.id }),
          }).catch(() => {});
        }
      } catch (error) {
        log(`TELEGRAM_POLL_FAILED ${error instanceof Error ? error.message : String(error)}`);
        await Bun.sleep(3000);
      }
    }
  };
  void loop();
  log("telegram long polling started");
  return { stop: () => { stopped = true; } };
}
