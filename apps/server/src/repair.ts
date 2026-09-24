import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir, getDb, getSetting, type TranscriptSegment } from "@uni/db";
import { parseTranscript } from "@uni/lms";
import { extractFilePages } from "./extract.js";

/**
 * Put right what older versions of the app wrote, once, at startup.
 *
 * Each repair is idempotent — it looks for data in the old shape and leaves
 * everything else alone — so running on every launch costs a few queries and
 * a fresh install does nothing at all. Nothing here deletes anything the
 * student made: review history, notes and uploads are never touched.
 */
export async function repairData(app: FastifyInstance): Promise<void> {
  const steps: [string, () => number | Promise<number>][] = [
    ["moved course files", relocateMaterials],
    ["raw caption transcripts", repairRawCaptions],
    ["unlabelled transcripts", labelTranscriptSources],
    ["slide decks without pages", () => addSlidePages()],
    ["leftover lecture audio", sweepAudio],
  ];
  for (const [what, run] of steps) {
    try {
      const n = await run();
      if (n) app.log.info(`Repair: ${what} — ${n} fixed`);
    } catch (e) {
      app.log.warn(`Repair: ${what} failed — ${String(e)}`);
    }
  }
}

/** Minimum usable caption text — the same bar the transcript pipeline applies. */
const MIN_CAPTION_CHARS = 1500;

/**
 * Course files are recorded by absolute path, so moving the app's folder
 * stranded every one of them: the Course files page couldn't open them and the
 * sync thought they were current. Point each back at its file under the
 * current data directory, where it almost always still is.
 */
function relocateMaterials(): number {
  const db = getDb();
  const rows = db.prepare("SELECT id, path FROM materials WHERE path IS NOT NULL").all() as {
    id: string;
    path: string;
  }[];
  let n = 0;
  for (const r of rows) {
    if (existsSync(r.path)) continue;
    const rel = r.path.split(/[\\/]data[\\/]/).pop();
    const moved = rel ? join(dataDir(), rel) : null;
    if (moved && moved !== r.path && existsSync(moved)) {
      db.prepare("UPDATE materials SET path = ? WHERE id = ?").run(moved, r.id);
      n++;
    }
  }
  return n;
}

/**
 * Transcripts stored as the caption API's raw JSON — a parser that didn't know
 * Echo's `data.contentJSON.cues` shape kept the whole response as "text", and
 * notes and flashcards were made from it. The cues are all in there, so re-read
 * them with their timings and let the notes be made again from the real words.
 */
function repairRawCaptions(): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT lecture_id, text FROM transcripts WHERE status = 'done' AND text LIKE '{%'")
    .all() as { lecture_id: string; text: string }[];
  for (const r of rows) {
    const captions = parseTranscript(r.text);
    if (!captions || captions.text.length < MIN_CAPTION_CHARS) {
      // Nothing usable in it after all — let the audio be transcribed instead.
      db.prepare("DELETE FROM transcripts WHERE lecture_id = ?").run(r.lecture_id);
    } else {
      db.prepare(
        "UPDATE transcripts SET text = ?, segments = ?, source = 'captions', summary = NULL WHERE lecture_id = ?",
      ).run(captions.text, captions.segments ? JSON.stringify(captions.segments) : null, r.lecture_id);
    }
    forgetAnalysis(r.lecture_id);
  }
  return rows.length;
}

/**
 * Transcripts from before the app recorded where they came from. The ledger
 * shows every earlier audio transcription went through OpenAI, and anything
 * else with timings came from captions.
 */
function labelTranscriptSources(): number {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE transcripts SET source = CASE
          WHEN (SELECT provider FROM lectures l WHERE l.id = transcripts.lecture_id) = 'slides' THEN 'slides'
          WHEN (SELECT provider FROM lectures l WHERE l.id = transcripts.lecture_id) = 'upload' THEN 'upload'
          WHEN segments IS NOT NULL THEN 'openai-whisper'
          ELSE 'captions' END
        WHERE status = 'done' AND source IS NULL`,
    )
    .run();
  return Number(r.changes);
}

/**
 * Slide decks read before pages were kept are one undivided blob of text. The
 * deck is almost always on disk already, so re-read it by page and redo its
 * notes — then they can say "slide 6" instead of nothing.
 */
export async function addSlidePages(lectureId?: string): Promise<number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT l.id, l.media_url, l.url FROM lectures l JOIN transcripts t ON t.lecture_id = l.id
        WHERE l.provider = 'slides' AND t.status = 'done' AND t.segments IS NULL
          ${lectureId ? "AND l.id = ?" : ""}`,
    )
    .all(...(lectureId ? [lectureId] : [])) as { id: string; media_url: string | null; url: string | null }[];
  let n = 0;
  for (const r of rows) {
    const stored = storedFile(r.media_url ?? r.url ?? "");
    if (!stored) continue;
    const pages = await extractFilePages(stored.path, stored.mimetype ?? "").catch(() => []);
    if (pages.length < 2) continue;
    const segments: TranscriptSegment[] = pages.map((p) => ({ start: 0, end: 0, page: p.page, text: p.text }));
    db.prepare("UPDATE transcripts SET segments = ?, source = 'slides' WHERE lecture_id = ?").run(
      JSON.stringify(segments),
      r.id,
    );
    forgetAnalysis(r.id);
    n++;
  }
  return n;
}

/**
 * Lecture audio left behind by versions that kept it after transcribing — about
 * 20 MB a lecture that nothing reads again. Only files in the app's own media
 * folder whose lecture is finished; never uploads, and not when the student has
 * asked to keep recordings.
 */
function sweepAudio(): number {
  if (getSetting("keep_audio") === "true") return 0;
  const dir = join(dataDir(), "media");
  if (!existsSync(dir)) return 0;
  const db = getDb();
  const owners = db
    .prepare("SELECT l.id, l.media_path, t.status FROM lectures l LEFT JOIN transcripts t ON t.lecture_id = l.id")
    .all() as { id: string; media_path: string | null; status: string | null }[];
  const byFile = new Map<string, { id: string; status: string | null }>();
  for (const o of owners) byFile.set(`${o.id.replace(/[^\w.-]/g, "_")}.mp3`, o);

  let n = 0;
  for (const file of readdirSync(dir)) {
    const owner = byFile.get(file);
    // Unknown files are left alone; so is audio for a lecture still in progress.
    if (!owner || owner.status !== "done") continue;
    rmSync(join(dir, file), { force: true });
    db.prepare("UPDATE lectures SET media_path = NULL WHERE id = ? AND media_path LIKE ?").run(owner.id, `%${file}`);
    n++;
  }
  return n;
}

/**
 * The copy of a file the course-file sync already downloaded, matched by name
 * (Moodle files the same PDF as a "lecture" and as a course file, under
 * different URLs).
 */
export function storedFile(url: string): { path: string; mimetype: string | null } | null {
  const name = decodeURIComponent((url.split("?")[0] ?? "").split("/").pop() ?? "");
  if (name.length < 4) return null;
  const row = getDb()
    .prepare("SELECT path, mimetype FROM materials WHERE title = ? AND path IS NOT NULL LIMIT 1")
    .get(name) as { path: string; mimetype: string | null } | undefined;
  return row && existsSync(row.path) ? row : null;
}

/**
 * Drop a lecture's analysis so the next notes pass makes it again, along with
 * a deck made from it — but only a deck that has never been studied.
 */
function forgetAnalysis(lectureId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM lecture_digests WHERE lecture_id = ?").run(lectureId);
  db.prepare(
    `DELETE FROM decks WHERE lecture_id = ? AND NOT EXISTS (
       SELECT 1 FROM cards c WHERE c.deck_id = decks.id AND (c.reviews > 0 OR c.introduced_at IS NOT NULL))`,
  ).run(lectureId);
}
