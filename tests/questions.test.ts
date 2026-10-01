import { expect, test } from "bun:test";
import { DEFAULT_KEYBOARD_LABELS, dedupeQuestions, parsePaneQuestions, parseQuestionCallback, parseSessionQuestionCalls, questionChoice, questionKeyboard, questionText } from "../src/questions.ts";

// Regression suite for the parser between a blocked agent and the owner's button press. Every case
// below was a real production bug: choices were dropped or truncated, answered questions were
// reposted next to the live one, and a cursor-marked first option vanished.

const call = (name: string, questions: unknown) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: { questions } }] } });

test("parses human-readable pane text with numbered choices and a write-your-own action", () => {
  const parsed = parsePaneQuestions("Question: which environment?\n1. staging\n2. production\n")!;
  expect(parsed.questions[0]!.text).toBe("which environment?");
  expect(parsed.questions[0]!.options.map((choice) => choice.value)).toEqual(["staging", "production"]);
  expect(questionText(parsed)).toContain("which environment?");
  expect(questionKeyboard(parsed, "q").flat().map((button) => button.callback_data)).toEqual(["q|0|0", "q|0|1", "q|0|w"]);
  expect(parseQuestionCallback("q|0|1", "q")).toMatchObject({ questionIndex: 0, optionIndex: 1, write: false, multi: false, confirm: false });
  expect(parseQuestionCallback("q|0|w", "q")).toMatchObject({ questionIndex: 0, optionIndex: null, write: true, multi: false, confirm: false });
  expect(questionChoice(parsed, 0, 1)?.label).toBe("production");
});

test("parses JSON questions, keeps multi-select, and refuses a callback from another prefix", () => {
  const parsed = parsePaneQuestions(JSON.stringify({ questions: [{ question: "pick one?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], multiSelect: true }] }))!;
  expect(parsed.questions[0]!.multiSelect).toBe(true);
  expect(parsed.questions[0]!.options.map((choice) => choice.value)).toEqual(["a", "b"]);
  expect(parseQuestionCallback("not-q|0|0", "q")).toBeNull();
  expect(parseQuestionCallback("q|0|c", "q")?.confirm).toBe(true);
});

test("a cursor-marked first option in pane text is kept, not dropped", () => {
  const parsed = parsePaneQuestions("Question: which side?\n→ 1. left\n   2. right\n")!;
  expect(parsed.questions[0]!.options.map((choice) => choice.label)).toEqual(["left", "right"]);
  const selected = parsePaneQuestions("which side?\n→ 1. left\n→ 2. right\n")!;
  expect(selected.questions[0]!.options.map((choice) => choice.label)).toEqual(["left", "right"]);
});

test("parses the tool call out of a session log line", () => {
  const log = call("request_user_input", [{ question: "which option?", options: [{ label: "first" }, { label: "second" }] }]);
  const parsed = parseSessionQuestionCalls(log)!;
  expect(parsed.questions[0]!.text).toBe("which option?");
  expect(parsed.questions[0]!.options.map((choice) => choice.value)).toEqual(["first", "second"]);
});

test("only the newest question call is used, so an answered question is not reposted beside the live one", () => {
  const answered = call("ask_user_question", [{ question: "round one?", options: [{ label: "A" }, { label: "B" }] }]);
  const live = call("ask_user_question", [{ question: "round two?", options: [{ label: "C" }, { label: "D" }] }]);
  const parsed = parseSessionQuestionCalls([answered, live].join("\n"))!;
  expect(parsed.questions).toHaveLength(1);
  expect(parsed.questions[0]!.text).toBe("round two?");
});

test("a retried question collapses to one so the payload stays within a platform's row limit", () => {
  const line = call("request_user_input", [{ question: "which way?", options: [{ label: "left" }, { label: "right" }] }]);
  const parsed = parseSessionQuestionCalls([line, line, line].join("\n"))!;
  expect(parsed.questions).toHaveLength(1);
  expect(dedupeQuestions([parsed.questions[0]!, { ...parsed.questions[0]!, options: [...parsed.questions[0]!.options] }])).toHaveLength(1);
});

test("a multi-question call keeps every question whole", () => {
  const parsed = parseSessionQuestionCalls(call("ask_user_question", [
    { question: "first?", options: [{ label: "A1" }, { label: "B1" }] },
    { question: "second?", options: [{ label: "A2" }, { label: "B2" }] },
    { question: "third?", options: [{ label: "A3" }, { label: "B3" }] },
  ]))!;
  expect(parsed.questions.map((q) => q.text)).toEqual(["first?", "second?", "third?"]);
  expect(questionKeyboard(parsed, "q")).toHaveLength(9);
});

test("a CRLF session log parses exactly like LF", () => {
  const line = call("ask_user_question", [{ question: "crlf?", options: [{ label: "A" }, { label: "B" }] }]);
  expect(parseSessionQuestionCalls(`${line}\n`)?.questions[0]?.text).toBe("crlf?");
  expect(parseSessionQuestionCalls(`${line}\r\n`)?.questions[0]?.text).toBe("crlf?");
  const pane = "Question: which side?\r\n→ 1. left\r\n   2. right\r\n";
  expect(parsePaneQuestions(pane)!.questions[0]!.options.map((c) => c.label)).toEqual(["left", "right"]);
});

test("non-ASCII question text and Korean-labeled pane output are parsed as data", () => {
  // The UI language is independent of this library: a Korean question must survive intact, and the
  // localized "질문:" prefix is matched as an alternative to "Question:".
  const parsed = parsePaneQuestions("질문: 어느 쪽으로 할까요?\n1. 왼쪽\n2. 오른쪽\n")!;
  expect(parsed.questions[0]!.text).toBe("어느 쪽으로 할까요?");
  expect(parsed.questions[0]!.options.map((choice) => choice.label)).toEqual(["왼쪽", "오른쪽"]);
  expect(questionKeyboard(parsed, "q").flat().map((b) => b.text)).toContain(DEFAULT_KEYBOARD_LABELS.write);
});

test("a single-select question that merely says 'select' is not treated as multi-select", () => {
  // "select" means "choose" in English and appears on single-select prompts, so it is not a
  // multi-select signal. Treating it as one added checkboxes and a "Done" button to plain questions.
  const parsed = parsePaneQuestions("Question: select the right answer\n1. A\n2. B\n")!;
  expect(parsed.questions[0]!.multiSelect).toBe(false);
  expect(questionKeyboard(parsed, "q").flat().map((button) => button.text)).toEqual(["A", "B", DEFAULT_KEYBOARD_LABELS.write]);
});

test("an explicit multi-select signal in the pane text is still detected", () => {
  for (const text of ["Question: 여러 개를 고르세요", "Question: pick multiple", "Question: 복수 선택"]) {
    expect(parsePaneQuestions(`${text}\n1. A\n2. B\n`)!.questions[0]!.multiSelect).toBe(true);
  }
});

test("keyboard labels can be localized without touching the parser", () => {
  const parsed = parsePaneQuestions("Question: which way?\n1. left\n2. right\n")!;
  const labels = { confirm: "선택 완료", write: "✍ 직접 쓰기" };
  const rows = questionKeyboard(parsed, "q", labels);
  expect(rows.flat().map((button) => button.text)).toContain(labels.write);
  expect(DEFAULT_KEYBOARD_LABELS.write).toBe("✍ Write your own");
});
