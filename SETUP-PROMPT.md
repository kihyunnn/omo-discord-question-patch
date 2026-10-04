# Setup prompt — chat buttons for a blocked agent's question

Paste everything between the markers below into a coding agent that works on your agent-runtime
repository. It implements the "question patch": when a session stops at an `ask_user_question`
prompt, its question and choices are posted as chat buttons; the owner's press is injected back into
that session and the message is edited to show the answer.

This is the hard-won version. Every rule marked *(measured)* is a bug that actually shipped.

----------------------------------------------------------------
[PROMPT START]
----------------------------------------------------------------

You are implementing, in an agent-runtime repository (Bun/TypeScript or Node/TypeScript), the
feature described below. Work on a branch and commit locally.

# Goal (ideal end state)

When a work session stops at an `ask_user_question` prompt (the internal tool name is
`request_user_input`), read the question and its choices and post them to the owner's chat as
buttons. When the owner presses one, that answer lands in the session's question prompt, the
message is edited to show the choice, and the buttons are disabled. A task opened from a second
platform (e.g. Telegram) behaves the same through that platform's inline keyboard.

# Runtime environment (per OS — macOS · Linux · Windows)

The reference runtime is designed to live on a **Linux host** (systemd units, `flock`, `mkfifo`, and
`/bin/sh` turn scripts). On other systems, split it into these three cases.

| | Linux (reference) | macOS | Windows |
|---|---|---|---|
| Runtime host | native (`systemd --user`) | works natively (`/bin/sh`, `mkfifo` exist); move the units to launchd | do not run the host directly — run the Linux runtime inside WSL2, or let a Linux host attach to it as a remote device over SSH |
| Agent session-log root | `$OMO_CODING_AGENT_DIR/sessions`, else `$HOME/.omo/agent/sessions` | same as Linux | `%OMO_CODING_AGENT_DIR%`, else `$HOME`, else `%USERPROFILE%`, then `.omo/agent/sessions`. **Do not use `os.homedir()` (= `%USERPROFILE%`) alone** — the agent may write under `$HOME` (e.g. `AppData\Roaming\...`) |
| Runtime config | `~/.config/<runtime>/config.toml` | same as Linux | `%APPDATA%\<runtime>\config.toml` |
| State / detection manifests | `~/.local/state/<runtime>/agent-detection/` | platform state dir (macOS convention `~/Library/Application Support/<runtime>/`) | platform state dir (Windows convention `%LOCALAPPDATA%\<runtime>\`) |
| Path separator | `/` | `/` | `\` (use `path.join`, never string concatenation) |
| Shell | `/bin/sh` | `/bin/sh` | PowerShell by default; wrap a POSIX launch line in Git Bash (`pane_shell=powershell` + a `bash` path) |
| Line endings | LF | LF | CRLF is possible — **the log parser must tolerate it** (`JSON.parse` accepts a trailing `\r`, so splitting on `\n` is fine) |

**Core rule — resolving the session-log root.** Never hardcode
`join(os.homedir(), ".omo/agent/sessions")`. Mirror the agent's own `agent-dir` resolution:

1. the first set of `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` (resolve it);
2. else `HOME`, else `USERPROFILE`, else `os.homedir()`;
3. then `.omo/agent/sessions` underneath.

Extract that order into pure functions (`agentDir` / `sessionRoot`) and make every reader
(tail reader, turn-ended check, model lookup, ref lookup, last-answer lookup) use the same value.
Unit-test it in win32/darwin/linux shapes, and verify each test by **mutation**: revert the function
to the bare `join(homedir(), …)` and confirm the test fails.

**On a remote device (SSH).** Apply the same rule in the remote shell (never a bare
`"$HOME"/.omo/agent/sessions`). Do not size a remote file with `stat -c %s` — that is GNU-only, and
**macOS's BSD `stat` has no `-c`, so the whole chain fails silently**. Use POSIX `wc -c < "$p"`.

**Windows remote devices.** The runtime's own CLI calls (`agent list`, `pane send-text`,
`pane send-keys`) use that device's binary and are OS-neutral. Only the pane launch line is POSIX
(`cd … && env …`), which PowerShell cannot parse — wrap it in Git Bash (see the table). The answer
injection path is still only `send-text` + `send-keys enter`.

# Must-haves

1. Only the owner can answer. A non-owner press is refused and nothing is injected.
2. Acknowledge the interaction within Discord's 3-second window (interaction response type 6), then
   do the state work and the injection afterwards.
3. Inject the answer through the existing pane-delivery path (`send-text` + `send-keys enter`).
   Remote devices use the existing SSH routing. Do not add a second injection path.
4. If the question is already resolved (the session is working again), disable the buttons and do not
   inject.
5. Pending questions survive a runtime restart (durable storage).
6. Never print tokens, cookies, or session values.

# Data-source priority (important)

- Parse the session JSONL tool-call arguments **first**. The log root differs per OS/install, so
  resolve it with the `agent-dir` rule above (see the environment table):
  `<agentDir>/sessions/*/*_<sessionId>.jsonl`. Inside `message.content[]`, take entries where
  `type:"toolCall"` and `name` is `request_user_input` / `ask_user_question`, and read
  `arguments.questions[]` (each has `question` and `options[].label|value`).
- Use the rendered pane text **only as a fallback**. That text draws the focused choice with a
  cursor glyph (`→ 1. Left`), so an option regex that does not allow a leading marker **loses the
  first choice** *(measured)*.
- A session log keeps every retried call, so the same question appears many times. Deduplicate
  before posting.
- **The tail still contains the previous round's question call.** Reading the log tail brings back
  an already-answered question; merging all calls reposts the answered question next to the live one
  and its buttons write to the wrong `questionIndex` *(measured: a modal test showed both rounds)*.
  Use **only the newest question call** (overwrite `latest`; never `push`). One call may still
  contain several questions — keep those together.

# Chat component rules (a real bug lived here)

- A message holds **at most 5 action rows**, each with **at most 5 buttons**. Exceeding it fails the
  **entire message** with `400 50035` ("Must be 5 or fewer in length").
- Pack at most 5 options per row.
- If that still exceeds 5 rows, **split into several messages** (each ≤5 rows). **Never silently
  truncate** — a truncated set makes the owner answer only the first question and believe they
  answered them all.
- Track **every message id** a pending question was posted as, and edit all of them on press or
  invalidation.
- Answer multiple questions **one at a time**. Answering one must not close the set: disable only the
  answered question's buttons (Discord: `disabled:true` plus a selection mark; Telegram: fold that
  question's row to "✅ answered") and close the whole set only after the last question.
  - **Trap (measured):** to disable only the answered question, pass **only that question's index**.
    A row builder that takes a global "disable everything" flag and receives `true` on the edit path
    closes **every** button on a partial answer, and the owner loses the way to answer the rest
    *(owner report: "pressing one closes them all")*. Do not have such a flag at all. Have the test
    inspect the API edit path's PATCH body and assert the remaining questions' buttons are **not**
    disabled.
- On a failed post, delete that blocked episode's dedupe row so the next tick retries. The same
  applies to a tick where parsing is not ready yet — otherwise the episode is swallowed forever.

# Chat gateway traps

- The gateway listener may overwrite `event.type` with an event-name string, so you cannot trust the
  numeric interaction type (3 = component, 9 = modal). Detect component/modal from
  `data.component_type` (2/3/4, string or number) or the `custom_id` prefix. Miss this and a button
  press falls through the slash-command path, no ack is sent, and the client shows
  "The application did not respond".
- A **modal submit** is the worst case of that trap: the same rewrite happens, and it carries **no
  `data.component_type`** and **no `message`** at all, so neither the numeric type nor a
  `component_type` check can see it. Only the `custom_id` prefix survives, so route `qwrite|<key>` to
  the modal handler by prefix *first*. A submit misrouted to the button handler is dropped with
  "the question is already over" and the typed answer is lost *(measured: the "✍ Write your own"
  answer silently vanished)*.
- "✍ Write your own" opens a modal (interaction response type 9). A modal response **cannot** be a
  deferred ack, so the write press must answer with the modal itself and keep that work synchronous and
  tiny (record the target question, no I/O) to stay inside the 3-second window. The modal's
  `custom_id` must carry the pending key, because the submit has no message to look the question up by.

# The second cause of a late ack (a stalled event loop)

- Fixing the routing above is not enough. If the question watcher reads the whole session log with
  `readFileSync`, a large log (measured up to 55 MB across a fleet) **blocks the event loop for
  seconds** and blows the 3-second window. The question is always at the end of the log, so read
  **only the last 512 KB** with a positional read (`openSync` + `readSync`, offset = size − length).
  Sending `ack()` first in the handler does not fix it — the synchronous read is what blocks.

# Prerequisite: the runtime must detect that pane as blocked

- The question watcher only looks at panes whose agent status is `blocked`. If the runtime's agent
  detection manifest (`<state dir>/agent-detection/*/<agent>.toml`; Linux
  `~/.local/state/<runtime>/agent-detection/`, macOS `~/Library/Application Support/<runtime>/`,
  Windows `%LOCALAPPDATA%\<runtime>\`) has no `state = "blocked"` rule for that agent, it is never
  detected and the buttons never appear. Inspect it OS-independently with the runtime's own
  explain command (e.g. `<cli> agent explain <target>` or `<cli> agent explain --file <manifest>
  --agent <label>`), which prints the state, the matched rule, and the evidence. Also, the session
  log must retain the question tool call's `arguments.questions[]` — some harnesses log only a
  header and the choices cannot be recovered. **Test with an agent that satisfies both conditions.**

# Avoid a runaway thread creation

- Opening a new task from inside a task session "to verify" creates threads endlessly. Refuse to
  open a new task from a task session and tell the caller to verify in place (allow an explicit
  override flag only when truly needed).

# Verification (in this order, and keep the evidence)

1. Pure-function regression: options pack to ≤5 buttons per row; 1/3/4/6-question sets stay ≤5 rows;
   **no question's buttons are lost when the set splits into several messages**; duplicate questions
   collapse to one; the cursor-marked first choice is kept.
2. Runtime regression: detect → post; press → `send-keys` injection; non-owner refused; an
   already-resolved question invalidated; a 3-question set stays open after the first answer and
   closes only at the end; a tick that failed to parse is retried on the next tick.
3. The full `bun test` (or your runner) plus the typecheck pass.
4. **The real surface**: in a real logged-in chat client, actually press the button and confirm
   (a) the answer lands in the session, (b) the message is edited to show the choice, and (c) the
   buttons are disabled. Do not stop at automated tests — most bugs in this feature only appeared
   live.

# Do not

- Do not call it "done" on automated tests alone.
- **Verify every new regression test by mutation.** Revert your fix to the buggy version and confirm
  the test fails. If it still passes, the test guards nothing. Real case: a first attempt at the ack
  ordering test passed even with the fix disabled (an ineffective test).
- When diagnosing a late ack, do not trust a string match for "did not respond" in the browser — the
  chat history keeps old copies of that text and the scan false-positives *(measured)*. Diagnose from
  the service log's interaction-failure lines and the message state read back over the API.
- Do not commit other people's uncommitted changes from a shared tree. Work on your own branch;
  merging and service restarts belong to the coordinator.

[PROMPT END]

----------------------------------------------------------------
[OPERATING NOTES]
----------------------------------------------------------------

- Portability checklist for another OS: (1) is the session-log root resolved by the `agent-dir`
  rule? (2) does the log parser tolerate CRLF? (3) is the remote file-size check free of
  `stat -c`? (4) does the remote shell resolve env-first instead of hardcoding `$HOME`? (5) is a
  Windows remote pane's launch line wrapped in Git Bash? Items 1/2/4/5 are pinned by pure-function
  or script-string unit tests; item 3 needs a macOS host or a shell without `stat -c`.
- Live verification order: (1) confirm the merge and restart are done; (2) raise an
  `ask_user_question` from a session you already have (do not open a new QA task — it creates
  another thread) as a **blocking** call that waits for an answer; a non-blocking call returns the
  pane to working and the runtime invalidates the question immediately; (3) press the button in the
  real chat client; (4) confirm injection, the edited message, and the disabled buttons; (5) delete
  any temporary thread, task, and session completely (not archive — an archived thread is still
  visible to the owner).
- Re-query the DOM on every click (`[role=button]` whose aria-label matches the button label);
  reusing a stale element ref can leave the click hidden behind an unread-jump banner and silently
  do nothing while exiting 0.
- This document contains no tokens or private values and can be handed to another person or machine
  as-is.
