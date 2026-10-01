# omo-discord-question-patch

Turn a blocked coding agent's `ask_user_question` prompt into **Discord buttons** (and Telegram
inline keyboards), and inject the owner's press straight back into the pane the agent is waiting in.

When an agent stops and asks a question, you usually have to walk to the machine and answer in the
terminal. This patch posts that question to chat as buttons, so you answer from your phone and the
session keeps going.

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

This repo is two things:

| | What it is | Where |
|---|---|---|
| **Spec** | A setup prompt you hand to a coding agent that already runs a pane runtime and a chat bot. It records every bug this feature hit in production, so the next implementation does not rediscover them. | [`SETUP-PROMPT.md`](SETUP-PROMPT.md) |
| **Reference implementation** | The pure parsing half: read the question, dedupe it, lay out buttons within each platform's limits, and decode a button press. No framework, no I/O. | [`src/questions.ts`](src/questions.ts) |

## Honest scope

This is **not** a turnkey tool. It is a spec plus the parser. To use it you need:

- a pane runtime that can report an agent as `blocked` and paste text back into that pane
  (the reference build uses [Herdr](https://herdr.dev); any runtime with a "send text + Enter"
  primitive works),
- a Discord bot or Telegram bot with a token, and
- a small watcher that ties the two together (the spec describes it).

If you do not have that, this is a well-documented design document.

## Install and verify

```sh
bun install
bun test                            # the parser's regression suite
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

The parser is drop-in; the rest is glue you write from the spec. Concretely:

- **`src/questions.ts` is the same logic the reference runtime runs.** It is that file with the
  branding removed, the one type-only import inlined, and the keyboard labels made configurable. So
  the parsing behavior in your runtime matches the tests here.
- **What this repo does not ship** is everything that touches the outside world: the watcher tick
  that finds blocked panes, the interaction handler that must acknowledge within Discord's 3-second
  window, the pane injection (`send-text` + `send-keys enter`), the durable pending-question store,
  and the blocked-detection prerequisite. [`SETUP-PROMPT.md`](SETUP-PROMPT.md) specifies all of them,
  including the traps (the synchronous log read that blows the ack window, the per-question disable
  flag that closes every button on a partial answer, the gateway that rewrites `event.type`).
- **In practice**: if you already run a pane runtime plus a chat bot, you can copy `src/questions.ts`
  and follow the spec to add the watcher and the handler. If you do not, treat this as a design
  document for building one.

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
