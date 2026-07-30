import { getDb, getSetting } from "@uni/db";
import { lectureNotes, hasApiKey } from "@uni/ai";
import { generateFrom } from "./decks.js";

/**
 * Generate tight, study-ready notes for a lecture from its transcript/slide text
 * and store them on the transcript. Called right after a transcript completes so
 * the student gets "learn this lecture in 5 minutes" for free.
 *
 * A flashcard deck follows from the same material, unless switched off — cards
 * you have to remember to ask for are cards you never make.
 */
export async function generateLectureNotes(lectureId: string): Promise<void> {
  if (!hasApiKey()) return;
  const db = getDb();
  const t = db.prepare("SELECT text FROM transcripts WHERE lecture_id = ?").get(lectureId) as
    | { text: string | null }
    | undefined;
  if (!t?.text || t.text.length < 200) return;
  const lec = db.prepare("SELECT title FROM lectures WHERE id = ?").get(lectureId) as
    | { title: string }
    | undefined;
  const summary = await lectureNotes(t.text, lec?.title).catch(() => null);
  if (summary) db.prepare("UPDATE transcripts SET summary = ? WHERE lecture_id = ?").run(summary, lectureId);

  await autoDeck(lectureId);
}

/** One deck per lecture, made once. Never regenerates over an existing deck. */
export async function autoDeck(lectureId: string): Promise<void> {
  if (getSetting("auto_flashcards") === "false") return;
  const existing = getDb()
    .prepare("SELECT id FROM decks WHERE lecture_id = ? LIMIT 1")
    .get(lectureId) as { id: string } | undefined;
  if (existing) return;
  await generateFrom({ type: "lecture", id: lectureId }).catch(() => null);
}
