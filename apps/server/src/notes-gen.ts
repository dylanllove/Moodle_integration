import { getDb } from "@uni/db";
import { lectureNotes, hasApiKey } from "@uni/ai";

/**
 * Generate tight, study-ready notes for a lecture from its transcript/slide text
 * and store them on the transcript. Called right after a transcript completes so
 * the student gets "learn this lecture in 5 minutes" for free.
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
}
