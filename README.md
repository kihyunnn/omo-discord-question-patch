# omo-discord-question-patch

Turn a blocked coding agent's `ask_user_question` prompt into **Discord buttons** (and Telegram
inline keyboards), and inject the owner's press straight back into the pane the agent is waiting in.

When an agent stops and asks a question, you usually have to walk to the machine and answer in the
terminal. This patch posts that question to chat as buttons, so you answer from your phone and the
session keeps going.

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
bun test          # the parser's regression suite
bun run typecheck
```

## The parser

```ts
import { parseSessionQuestionCalls, questionKeyboard, parseQuestionCallback, questionChoice } from "./src/questions.ts";

const parsed = parseSessionQuestionCalls(sessionLogTail);      // newest tool call only
const rows = questionKeyboard(parsed, "q");                    // Button[][] for your platform
const press = parseQuestionCallback("q|0|1", "q");             // which question, which option
const choice = questionChoice(parsed, press.questionIndex, press.optionIndex);
```

Button labels are English by default and can be localized without touching the parser:

```ts
questionKeyboard(parsed, "q", { confirm: "선택 완료", write: "✍ 직접 쓰기" });
```

Two entry points matter:

- `parseSessionQuestionCalls(log)` — reads the **newest** `ask_user_question` / `request_user_input`
  call from a session-log tail. Earlier calls were already answered; merging them back reposts an
  answered question next to the live one, and its buttons write to the wrong index.
- `parsePaneQuestions(text)` — fallback for the pane's rendered text. The focused option is drawn
  with a cursor glyph (`→ 1. Left`); the option regex allows that marker, because dropping it loses
  the first choice.

## Rules the code enforces (each was a production bug)

- **Newest call only** — answered questions must not reappear beside the live one.
- **Dedupe identical calls** — a retried question would otherwise exceed the platform's row limit.
- **Never truncate options** — Discord allows at most 5 action rows of 5 buttons; overflow splits
  into more messages instead of silently dropping choices.
- **CRLF-tolerant** — a Windows-written log tail parses identically to LF.
- **Cursor-marked first option kept** — the focused choice must not vanish.
- **Non-ASCII safe** — a Korean (or any non-English) question survives intact, and a localized
  `질문:` prefix is matched alongside `Question:`.

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
