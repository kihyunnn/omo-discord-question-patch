// The only outside dependency in the original runtime was this type alias, inlined here so the
// module stands alone.
export type Button = { text: string; callback_data: string };
export type Keyboard = Button[][];

export type QuestionOption = { label: string; value: string };
export type PaneQuestion = { text: string; options: QuestionOption[]; multiSelect: boolean };
export type ParsedQuestions = { questions: PaneQuestion[]; raw: string };

// The ask-user UI marks the focused option with a cursor glyph (`→ 1. Left`, `   2. Right`). Without
// allowing that leading marker the first choice was dropped from the pane text, so a question
// showed only its remaining options. This was a real production bug.
const OPTION = /^\s*(?:[→❯▶▸»>●○]\s*)?(?:[-*•]|\[\s*[ xX]?\s*\]|\(?\d+[.)]|[A-Za-z][.)])\s+(.+?)\s*$/u;
// `question`, `질문` and a bare `N.` prefix are all accepted, so the parser works on a
// non-English question UI as well as an English one.
const QUESTION = /^\s*(?:[→❯▶▸»>]\s*)?(?:\?|(?:question|질문)\s*[:：]|\d+[.)])\s*(.+?)\s*$/iu;

function clean(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function option(value: string): QuestionOption | null { const label = clean(value); return label === "" ? null : { label: label.slice(0, 80), value: label }; }

function fromJson(value: unknown): PaneQuestion[] {
  if (!value || typeof value !== "object") return [];
  const root = value as { question?: unknown; questions?: unknown; options?: unknown; multiSelect?: unknown; multi_select?: unknown };
  const list = Array.isArray(root.questions) ? root.questions : [value];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { question?: unknown; text?: unknown; prompt?: unknown; options?: unknown; choices?: unknown; multiSelect?: unknown; multi_select?: unknown };
    const rawOptions = Array.isArray(row.options) ? row.options : Array.isArray(row.choices) ? row.choices : [];
    const options = rawOptions.flatMap((entry): QuestionOption[] => {
      if (typeof entry === "string") return option(entry) ? [option(entry)!] : [];
      if (!entry || typeof entry !== "object") return [];
      const e = entry as { label?: unknown; text?: unknown; value?: unknown; name?: unknown };
      const label = typeof e.label === "string" ? e.label : typeof e.text === "string" ? e.text : typeof e.name === "string" ? e.name : "";
      const parsed = option(label);
      return parsed ? [{ ...parsed, value: typeof e.value === "string" ? e.value : parsed.value }] : [];
    });
    const text = typeof row.question === "string" ? row.question : typeof row.text === "string" ? row.text : typeof row.prompt === "string" ? row.prompt : "";
    return text.trim() && options.length > 0 ? [{ text: clean(text).slice(0, 1000), options, multiSelect: row.multiSelect === true || row.multi_select === true || (row as { multiple?: unknown }).multiple === true }] : [];
  });
}

// A session log keeps every tool call, so a retried or repeated question shows up many times.
// Discord rejects more than 5 action rows (error 50035), so identical questions collapse to one.
function signature(question: PaneQuestion): string {
  return `${question.text}\u0000${question.options.map((choice) => `${choice.label}\u0001${choice.value}`).join("\u0002")}`;
}

export function dedupeQuestions(questions: PaneQuestion[]): PaneQuestion[] {
  const seen = new Set<string>();
  const out: PaneQuestion[] = [];
  for (const question of questions) {
    const key = signature(question);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(question);
  }
  return out;
}

export function parsePaneQuestions(input: string): ParsedQuestions | null {
  const raw = input.trim();
  if (raw === "") return null;
  try {
    const parsed = dedupeQuestions(fromJson(JSON.parse(raw)));
    if (parsed.length > 0) return { questions: parsed, raw };
  } catch { /* The runtime's human-readable pane output is the normal path. */ }

  const lines = raw.split("\n").map(clean).filter(Boolean);
  const questions: PaneQuestion[] = [];
  let current: PaneQuestion | null = null;
  for (const line of lines) {
    const match = line.match(QUESTION);
    const choice = line.match(OPTION);
    if (match && !choice) {
      if (current && current.options.length > 0) questions.push(current);
      current = { text: clean(match[1]!).slice(0, 1000), options: [], multiSelect: /multi|select|여러|복수/i.test(line) };
      continue;
    }
    if (choice && current) { const parsed = option(choice[1]!); if (parsed) current.options.push(parsed); continue; }
    if (!current && line.endsWith("?")) current = { text: line.slice(0, 1000), options: [], multiSelect: false };
  }
  if (current && current.options.length > 0) questions.push(current);
  if (questions.length === 0) {
    const optionLines = lines.map((line) => option(line.replace(/^\d+[.)]\s*/u, ""))).filter((x): x is QuestionOption => x !== null);
    const questionLine = lines.find((line) => line.endsWith("?"));
    if (questionLine && optionLines.length > 0) questions.push({ text: questionLine.slice(0, 1000), options: optionLines, multiSelect: false });
  }
  const unique = dedupeQuestions(questions);
  return unique.length > 0 ? { questions: unique, raw } : null;
}

export function parseSessionQuestionCalls(input: string): ParsedQuestions | null {
  // Only the newest question call is what the pane is waiting on now. Earlier ones were already
  // answered, and merging them back reposted an answered question next to the live one with buttons
  // that write to the wrong question index. A single call still yields every question it contains,
  // so a multi-question set is kept whole.
  let latest: PaneQuestion[] | null = null;
  for (const line of input.split("\n")) {
    if (!line.includes('"name":"request_user_input"') && !line.includes('"name":"ask_user_question"')) continue;
    try {
      const row = JSON.parse(line) as { message?: { content?: Array<{ type?: string; name?: string; arguments?: unknown }> } };
      const call = row.message?.content?.find((entry) => entry.type === "toolCall" && (entry.name === "request_user_input" || entry.name === "ask_user_question"));
      const args = call?.arguments as { questions?: unknown[]; question?: unknown; options?: unknown[] } | undefined;
      if (Array.isArray(args?.questions)) {
        const converted = fromJson({ questions: args.questions });
        if (converted.length > 0) latest = converted;
      } else if (typeof args?.question === "string" && Array.isArray(args.options)) {
        const converted = fromJson({ question: args.question, options: args.options });
        if (converted.length > 0) latest = converted;
      }
    } catch { /* Ignore malformed session lines and continue scanning. */ }
  }
  const unique = latest ? dedupeQuestions(latest) : [];
  return unique.length > 0 ? { questions: unique, raw: input } : null;
}

export function questionText(parsed: ParsedQuestions): string {
  return parsed.questions.map((q, i) => `${parsed.questions.length > 1 ? `${i + 1}. ` : ""}${q.text}`).join("\n");
}

export type KeyboardLabels = { confirm: string; write: string };
export const DEFAULT_KEYBOARD_LABELS: KeyboardLabels = { confirm: "Done", write: "✍ Write your own" };

export function questionKeyboard(parsed: ParsedQuestions, prefix: string, labels: KeyboardLabels = DEFAULT_KEYBOARD_LABELS): Keyboard {
  const rows: Keyboard = [];
  parsed.questions.forEach((question, questionIndex) => {
    question.options.forEach((choice, optionIndex) => rows.push([{ text: `${question.multiSelect ? "☐ " : ""}${choice.label}`, callback_data: `${prefix}|${questionIndex}|${optionIndex}`.slice(0, 64) }]));
    if (question.multiSelect) rows.push([{ text: labels.confirm, callback_data: `${prefix}|${questionIndex}|c` }]);
    rows.push([{ text: labels.write, callback_data: `${prefix}|${questionIndex}|w`.slice(0, 64) }]);
  });
  return rows;
}

export function parseQuestionCallback(data: string, prefix: string): { questionIndex: number; optionIndex: number | null; write: boolean; multi: boolean; confirm: boolean } | null {
  const parts = data.split("|");
  if (parts.shift() !== prefix) return null;
  const q = parts.shift();
  const choice = parts.length === 1 ? parts[0] : parts[parts.length - 1];
  if (!/^\d+$/.test(q ?? "") || (choice !== "w" && choice !== "m" && choice !== "c" && !/^\d+$/.test(choice ?? ""))) return null;
  return { questionIndex: Number(q), optionIndex: choice === "w" || choice === "m" || choice === "c" ? null : Number(choice), write: choice === "w", multi: choice === "m", confirm: choice === "c" };
}

export function questionChoice(parsed: ParsedQuestions, questionIndex: number, optionIndex: number | null): QuestionOption | null {
  return parsed.questions[questionIndex]?.options[optionIndex ?? -1] ?? null;
}
