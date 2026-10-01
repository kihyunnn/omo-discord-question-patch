import { Database } from "bun:sqlite";
import type { ParsedQuestions } from "./questions.ts";

export type QuestionOrigin =
  | { platform: "discord"; channelId: string }
  | { platform: "telegram"; chatId: string; threadId: string | null };

// A question the owner still has to answer. `answered` maps a question index to the chosen answer,
// so a set can be answered one question at a time and a restart can resume mid-set.
export type PendingQuestion = {
  key: string;
  paneId: string;
  sessionId: string | null;
  parsed: ParsedQuestions;
  messageIds: string[];
  origin: QuestionOrigin;
  answered: Record<number, string>;
  awaitingTextFor: number | null;
};

type PendingRow = {
  key: string; pane_id: string; session_id: string | null; parsed: string;
  message_id: string; origin: string; answered: string | null; awaiting_text_for: number | null;
};

// Pending questions are durable: the buttons stay usable across a restart, and the blocked-episode
// rows are the dedupe that keeps one blocked pane from being posted every tick.
export class QuestionStore {
  readonly db: Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS pending_questions(key TEXT PRIMARY KEY, pane_id TEXT NOT NULL, session_id TEXT, parsed TEXT NOT NULL, message_id TEXT NOT NULL, origin TEXT NOT NULL, answered TEXT, awaiting_text_for INTEGER)");
    this.db.exec("CREATE TABLE IF NOT EXISTS blocked_episodes(key TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
  }

  close(): void { this.db.close(); }

  loadPending(): PendingQuestion[] {
    const rows = this.db.query("SELECT key,pane_id,session_id,parsed,message_id,origin,answered,awaiting_text_for FROM pending_questions").all() as PendingRow[];
    const out: PendingQuestion[] = [];
    for (const row of rows) {
      try {
        out.push({
          key: row.key,
          paneId: row.pane_id,
          sessionId: row.session_id,
          parsed: JSON.parse(row.parsed) as ParsedQuestions,
          messageIds: JSON.parse(row.message_id) as string[],
          origin: JSON.parse(row.origin) as QuestionOrigin,
          answered: row.answered ? JSON.parse(row.answered) as Record<number, string> : {},
          awaitingTextFor: row.awaiting_text_for,
        });
      } catch {
        // A row this build cannot read is dropped rather than re-posted broken.
        this.forget(row.key);
      }
    }
    return out;
  }

  save(pending: PendingQuestion): void {
    this.db.query("INSERT OR REPLACE INTO pending_questions(key,pane_id,session_id,parsed,message_id,origin,answered,awaiting_text_for) VALUES(?,?,?,?,?,?,?,?)")
      .run(pending.key, pending.paneId, pending.sessionId, JSON.stringify(pending.parsed), JSON.stringify(pending.messageIds), JSON.stringify(pending.origin), JSON.stringify(pending.answered), pending.awaitingTextFor);
  }

  forget(key: string): void { this.db.query("DELETE FROM pending_questions WHERE key=?").run(key); }

  // True the first time an episode is seen. A pane that is still blocked stays one episode; a new
  // blocked episode (the status timestamp moved) is posted again.
  beginEpisode(key: string, at = new Date().toISOString()): boolean {
    return this.db.query("INSERT OR IGNORE INTO blocked_episodes(key,created_at) VALUES(?,?)").run(key, at).changes === 1;
  }

  clearEpisode(key: string): void { this.db.query("DELETE FROM blocked_episodes WHERE key=?").run(key); }
}
