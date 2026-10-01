# omo-discord-question-patch

Turn a blocked coding agent's `ask_user_question` prompt into **Discord buttons** (and Telegram
inline keyboards), and inject the owner's press straight back into the pane the agent is waiting in.

When an agent stops and asks a question, you usually have to walk to the machine and answer in the
terminal. This patch posts that question to chat as buttons, so you answer from your phone and the
session keeps going.

![A real Discord message: a blocked agent's question with answer buttons](assets/discord-buttons.png)

*A real capture, not a mockup — a blocked session's question posted to Discord with its answer
buttons. The example question is in Korean; the buttons are "home server", "remote host", and
"write your own".*

```
┌─ the agent's terminal ─────────────┐        ┌─ your phone ──────────────────────┐
│                                    │        │ Which environment should I        │
│  ? Which environment should I      │        │ deploy to?                        │
│    deploy to?                      │        │                                   │
│  ❯ 1. staging                      │  ───▶  │ ┌───────────────────────────────┐ │
│    2. production                   │        │ │ staging                       │ │
│    3. a preview branch             │        │ ├───────────────────────────────┤ │
│                                    │        │ │ production                    │ │
│  (the session is blocked, waiting) │        │ ├───────────────────────────────┤ │
│                                    │        │ │ a preview branch              │ │
│                                    │        │ ├───────────────────────────────┤ │
│                                    │        │ │ ✍ Write your own              │ │
│                                    │        │ └───────────────────────────────┘ │
└────────────────────────────────────┘        └───────────────────────────────────┘
         one press injects "production" back into the waiting prompt
```

This repo is three things:

| | What it is | Where |
|---|---|---|
| **Runtime** | A working, Herdr-only watcher: blocked pane → chat buttons → answer injected back. | [`src/`](src/) |
| **Spec** | The setup prompt you hand to a coding agent, recording every bug this feature hit in production. | [`SETUP-PROMPT.md`](SETUP-PROMPT.md) |
| **Parser** | The pure parsing half on its own: read the question, dedupe it, lay out buttons, decode a press. | [`src/questions.ts`](src/questions.ts) |

## Honest scope

This is **Herdr-only**. It talks to [Herdr](https://herdr.dev) for everything pane-related —
`herdr agent list` gives the blocked/idle state, `herdr agent read` gives the pane text, and
`herdr pane send-text` + `send-keys enter` inject the answer. There is no abstraction over other pane
runtimes; if you do not run Herdr, use [`SETUP-PROMPT.md`](SETUP-PROMPT.md) as the spec instead.

You still need a Discord bot or Telegram bot with a token, and an agent (omo or another one whose
session log records an `ask_user_question` / `request_user_input` tool call) running inside a Herdr
pane.

## Run it

```sh
bun install
cp config.example.json ~/.config/omo-question-patch/config.json   # then fill it in
bun run src/main.ts
```

Config comes from that file and/or the environment (the environment wins, so a token can stay out of
the file): `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_OWNER_ID`, `DISCORD_PUBLIC_KEY`,
`DISCORD_PORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_OWNER_ID`, `HERDR_BIN`,
`QUESTION_PATCH_INTERVAL_MS`, `QUESTION_PATCH_STATE`, `QUESTION_PATCH_CONFIG`.

Inbound presses arrive two ways:

- **Discord** — an interactions endpoint (`POST /discord/interactions`) on `discord.port`, verified
  against the app's Ed25519 public key. Point the app's Interactions URL at it (a tunnel or reverse
  proxy is usually needed). The handler acknowledges inside Discord's 3-second window (type 6) and
  does the injection after, so the ack is never spent on the answer work.
- **Telegram** — long polling; no public URL needed.

### What one tick does

1. `herdr agent list` — panes whose status is `blocked`.
2. Read the pane's session log (found from its cwd, tail only) for the **newest** question call;
   fall back to the rendered pane text.
3. Post the question as chat buttons (Discord components, or a Telegram inline keyboard).
4. A pane that is working again has its question invalidated.
5. On a press: verify the presser is the owner, inject the answer with `send-text` + `send-keys
   enter`, and edit the message. A multi-question set stays open until the last answer; only the
   answered question's buttons are disabled.

Pending questions are stored in SQLite, so a restart keeps the buttons usable. Every Herdr call is
bounded by a timeout, and the log read is a positional tail read, never a whole-file read.

## Install and verify

```sh
bun install
bun test                            # parser and runtime regression suites
bun run typecheck
bun run examples/render-example.ts  # regenerates the worked example below
```

## Worked example

Everything in this section is printed by
[`examples/render-example.ts`](examples/render-example.ts), which runs the shipped parser — the
button rows are the parser's real output, not hand-written documentation.

### 1. What the agent's terminal shows

The agent calls `ask_user_question` and the session blocks. Its pane renders the question with a
cursor glyph on the focused choice:

```
? Which environment should I deploy to?
❯ 1. staging
  2. production
  3. a preview branch
```

That glyph is why the parser allows a leading marker: an option regex that does not would silently
drop the first choice.

### 2. Where the question really comes from

The pane text is only the **fallback**. The primary source is the session log, which records the
tool call itself:

```json
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"ask_user_question",
 "arguments":{"questions":[{"question":"Which environment should I deploy to?",
 "options":[{"label":"staging"},{"label":"production"},{"label":"a preview branch"}]}]}}]}}
```

The parser reads the **newest** such call in the log tail — never all of them, or an already
answered question is reposted next to the live one.

### 3. What gets posted

`questionKeyboard()` turns the parsed question into button rows:

```
message 1:
[ staging ]
[ production ]
[ a preview branch ]
[ ✍ Write your own ]
```

Pressing `production` injects that choice into the waiting prompt, and the message is edited to show
the answer with the buttons disabled.

### 4. A multi-question set is split, never truncated

Three questions produce 9 rows. Discord allows at most **5 action rows per message**, so the set is
posted as two messages:

```
1. Deploy to which environment?
2. Run the migrations first?
3. Notify the team?

message 1:
[ staging ]
[ production ]
[ ✍ Write your own ]
[ yes ]
[ no ]

message 2:
[ ✍ Write your own ]
[ yes ]
[ no ]
[ ✍ Write your own ]
```

Truncating to the first 5 rows instead would leave the owner answering one question and believing
they answered all three — a bug that actually shipped once.

## How this was handled before the patch

The buttons were not the first version. Before them, a blocked session produced a **notification
only** — no buttons, no way to answer from chat:

- the owner got a message saying the session had stopped at an approval/question screen, naming the
  pane and telling them to go read it and answer there, or
- the runtime pasted the same note into its own main session, which then had to relay it.

Answering meant opening the pane and typing, which defeats the point of an always-on assistant: the
owner had to be at a terminal to unblock a session. The button patch replaced that dead end with an
answerable message, and kept the old notification as the fallback for the one case it cannot handle
— a blocked pane whose question could not be parsed yet (the log write can lag the blocked state by
a tick).

## Rules the code enforces (each was a production bug)

- **Newest call only** — answered questions must not reappear beside the live one.
- **Dedupe identical calls** — a retried question would otherwise exceed the platform's row limit.
- **Never truncate options** — Discord allows at most 5 action rows of 5 buttons; overflow splits
  into more messages instead of silently dropping choices.
- **CRLF-tolerant** — a Windows-written log tail parses identically to LF.
- **Cursor-marked first option kept** — the focused choice must not vanish.
- **Non-ASCII safe** — a non-English question survives intact, and a localized question prefix is
  matched alongside `Question:`.

## Can I use this to patch my own runtime?

The runtime here is Herdr-only, so if you run Herdr you can run it as-is. Otherwise:

- **`src/questions.ts` is the parser the reference runtime runs.** It is that file with the
  branding removed, the one type-only import inlined, and the keyboard labels made configurable, so
  the parsing behavior — including the multi-select rule — matches. Both repos carry a test that
  pins the multi-select rule (`multi` / `여러` / `복수`, never the English word "select", which
  appears on single-select prompts too).
- **Everything else in `src/` is Herdr-specific glue** you can port or replace: the CLI wrapper,
  the cwd → session-log lookup, the durable pending-question store, the chat adapters, and the tick.
  [`SETUP-PROMPT.md`](SETUP-PROMPT.md) specifies all of it, including the traps (the synchronous log
  read that blows the ack window, the per-question disable flag that closes every button on a
  partial answer, the gateway that rewrites `event.type`).

## Cross-platform notes

The feature reads the agent's session log, and **where that log lives is OS-specific**. Resolve it
the way the agent runtime does, never with a bare home directory:

1. an explicit `OMO_CODING_AGENT_DIR` / `SENPI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR` override,
2. else `HOME`, else Windows' `USERPROFILE`, else the OS home,
3. then `.omo/agent/sessions`.

On Windows the runtime may prefer `HOME` (e.g. under `AppData\Roaming\...`) over `%USERPROFILE%`, so
`os.homedir()` alone reads the wrong directory. When reading a remote device's log over SSH, resolve
the same way there, and probe file sizes with POSIX `wc -c` — GNU-only `stat -c` is rejected by
macOS's BSD `stat` and fails silently.

## License

MIT — see [LICENSE](LICENSE).
