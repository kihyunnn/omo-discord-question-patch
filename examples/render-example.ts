/**
 * Renders the README's worked example from the shipped parser, so the button rows shown in the docs
 * are what the code actually produces. Run: `bun run examples/render-example.ts`.
 */
import { parsePaneQuestions, parseSessionQuestionCalls, questionKeyboard, questionText } from "../src/questions.ts";
import type { Keyboard } from "../src/questions.ts";

const MAX_ROWS_PER_MESSAGE = 5;

// Discord caps a message at 5 action rows of 5 buttons. A set that exceeds it is split, never
// truncated, so the owner still sees every question.
export function splitMessages(rows: Keyboard): Keyboard[] {
  const messages: Keyboard[] = [];
  for (let at = 0; at < rows.length; at += MAX_ROWS_PER_MESSAGE) messages.push(rows.slice(at, at + MAX_ROWS_PER_MESSAGE));
  return messages;
}

// What the agent's terminal shows while it waits. The focused choice carries a cursor glyph.
const TERMINAL = [
  "? Which environment should I deploy to?",
  "❯ 1. staging",
  "  2. production",
  "  3. a preview branch",
].join("\n");

// The same question as the runtime's session log records it: the primary source, with the terminal
// text above used only as a fallback when the log has not been written yet.
const SESSION_LOG = JSON.stringify({
  type: "message",
  message: {
    role: "assistant",
    content: [{
      type: "toolCall",
      name: "ask_user_question",
      arguments: {
        questions: [{
          question: "Which environment should I deploy to?",
          options: [
            { label: "staging", description: "deploy to staging" },
            { label: "production", description: "deploy to production" },
            { label: "a preview branch", description: "deploy a throwaway preview" },
          ],
        }],
      },
    }],
  },
});

const threeQuestions = parseSessionQuestionCalls(JSON.stringify({
  type: "message",
  message: {
    role: "assistant",
    content: [{
      type: "toolCall",
      name: "ask_user_question",
      arguments: {
        questions: [
          { question: "Deploy to which environment?", options: [{ label: "staging" }, { label: "production" }] },
          { question: "Run the migrations first?", options: [{ label: "yes" }, { label: "no" }] },
          { question: "Notify the team?", options: [{ label: "yes" }, { label: "no" }] },
        ],
      },
    }],
  },
}))!;

const draw = (rows: Keyboard) => rows.map((row) => row.map((button) => `[ ${button.text} ]`).join("  ")).join("\n");
const drawMessages = (rows: Keyboard) => splitMessages(rows).map((message, i) => `message ${i + 1}:\n${draw(message)}`).join("\n\n");

const single = questionKeyboard(parseSessionQuestionCalls(SESSION_LOG)!, "q");
const triple = questionKeyboard(threeQuestions, "q");

console.log("=== TERMINAL CAPTURE (fallback source) ===");
console.log(TERMINAL);
console.log("\n=== PARSED QUESTION ===");
console.log(questionText(parsePaneQuestions(TERMINAL)!));
console.log("\n=== SESSION LOG LINE (primary source) ===");
console.log(SESSION_LOG);
console.log("\n=== BUTTONS POSTED (one question) ===");
console.log(drawMessages(single));
console.log(`\nrows: ${single.length}, messages: ${splitMessages(single).length}`);
console.log("\n=== BUTTONS POSTED (three questions) ===");
console.log(questionText(threeQuestions));
console.log("");
console.log(drawMessages(triple));
console.log(`\nrows: ${triple.length}, messages: ${splitMessages(triple).length} (split, not truncated)`);
console.log("\n=== PARITY: terminal path vs log path ===");
console.log("same labels:", JSON.stringify(questionKeyboard(parsePaneQuestions(TERMINAL)!, "q").flat().map((b) => b.text)) === JSON.stringify(single.flat().map((b) => b.text)));
