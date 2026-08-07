import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { getDb, dataDir } from "@uni/db";
import { extractAudioMp3, transcribeFile } from "@uni/transcribe";
import { cleanTranscript, hasApiKey } from "@uni/ai";
import {
  acquireEchoContext,
  echoConnected,
  fetchAnyTranscript,
  probeClassroom,
  withEchoLock,
  withToken,
} from "@uni/lms";
import { extractSlideText } from "./extract.js";
import { generateLectureNotes } from "./notes-gen.js";

/**
 * Get a transcript for every lecture that can possibly have one.
 *
 * Transcription used to happen in exactly one place — the Echo360 sync, for
 * lessons it had just listed. Everything else fell through the gap: the ten
 * slide decks Moodle files as "lectures" and whose text was never extracted, the
 * recordings that failed once and were never retried, the classes that hadn't
 * been published yet when we last looked. This walks the whole table instead,
 * and picks the cheapest route that works for each one.
 */

/** Attempts per run, so a first sync can't spend an afternoon in Whisper. */
const MAX_PER_RUN = 6;
/** Notes are a single cheap call each, so a few more per run is fine. */
const MAX_NOTES_PER_RUN = 8;
/** How long before a failed attempt is worth repeating. */
const RETRY_ERROR_MS = 2 * 3600_000;
/** An unpublished recording, while the class is still recent. */
const RETRY_PENDING_MS = 30 * 60_000;
/** Once a lecture is this old, an absent recording is probably permanent. */
const STALE_LECTURE_DAYS = 14;
const RETRY_STALE_MS = 24 * 3600_000;
/**
 * How long a lecture may sit mid-flight before we assume nobody's working on it.
 * Closing the laptop during a download leaves a row saying "transcribing" that
 * no longer has a process behind it; without this it stays that way forever.
 */
const IN_FLIGHT_TIMEOUT_MS = 30 * 60_000;

export interface BackfillResult {
  attempted: number;
  transcribed: number;
  stillWaiting: number;
  failed: number;
  /** Left for the next run by MAX_PER_RUN — never silently dropped. */
  deferred: number;
  /** Transcripts that were finished but had no study notes until now. */
  noted: number;
}

interface LectureRow {
  id: string;
  course_id: string | null;
  title: string;
  provider: string | null;
  url: string | null;
  media_url: string | null;
  media_path: string | null;
  recorded_at: string | null;
  status: string | null;
  updated_at: string | null;
}

export async function backfillTranscripts(app: FastifyInstance): Promise<BackfillResult> {
  const db = getDb();
  const out: BackfillResult = {
    attempted: 0,
    transcribed: 0,
    stillWaiting: 0,
    failed: 0,
    deferred: 0,
    noted: 0,
  };

  // Only courses the student actually wants pulled down. Transcribing an hour of
  // audio for a notice board they'll never read is the most expensive way for
  // this app to waste their money.
  const rows = db
    .prepare(
      `SELECT l.id, l.course_id, l.title, l.provider, l.url, l.media_url, l.media_path,
              l.recorded_at, t.status, t.updated_at
         FROM lectures l
         LEFT JOIN transcripts t ON t.lecture_id = l.id
         LEFT JOIN courses c ON c.id = l.course_id
        WHERE (t.status IS NULL OR t.status <> 'done')
          AND (l.course_id IS NULL OR (c.excluded = 0 AND c.sync_lectures = 1))
        ORDER BY l.recorded_at IS NULL, l.recorded_at DESC`,
    )
    .all() as unknown as LectureRow[];

  const due = rows.filter(isDue);
  if (due.length > MAX_PER_RUN) out.deferred = due.length - MAX_PER_RUN;
  const batch = due.slice(0, MAX_PER_RUN);

  const runBatch = async (echoCtx: EchoContext | null): Promise<void> => {
    for (const lecture of batch) {
      out.attempted++;
      try {
        const result = await transcribeOne(app, lecture, echoCtx);
        if (result === "transcribed") out.transcribed++;
        else out.stillWaiting++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (isInfrastructureFailure(message)) {
          // Put it back where it was so the next run picks it straight up.
          clearStatus(lecture.id);
          out.stillWaiting++;
          app.log.warn(`Transcript ${lecture.id}: interrupted, will retry — ${message}`);
          // The browser is gone; the rest of the batch would fail the same way.
          if (echoCtx) break;
        } else {
          out.failed++;
          setError(lecture.id, message);
          app.log.warn(`Transcript ${lecture.id}: ${message}`);
        }
      }
    }
  };

  // Everything that drives the Echo360 browser holds the lock for as long as it
  // uses it. Two contexts open at once would each save the session on the way
  // out, and the loser's write would undo the winner's.
  if (batch.some((r) => r.provider === "echo360") && echoConnected()) {
    await withEchoLock(async () => {
      const echo = await acquireEchoContext().catch(() => null);
      try {
        await runBatch(echo?.ctx ?? null);
      } finally {
        if (echo) await echo.done().catch(() => {});
      }
    });
  } else {
    await runBatch(null);
  }

  if (out.deferred) {
    app.log.info(`Transcripts: ${out.deferred} more due, left for the next run`);
  }
  out.noted = await backfillNotes(app);
  return out;
}

/**
 * Study notes and a deck for transcripts that have text but never got them.
 *
 * Notes are written immediately after a transcript lands, so anything that
 * interrupts that moment — a restart, a lid closing, an OpenAI hiccup — leaves a
 * transcript that is finished and will never be looked at again, because every
 * other pass here skips 'done'. This is the one thing that goes back for them.
 */
async function backfillNotes(app: FastifyInstance): Promise<number> {
  if (!hasApiKey()) return 0;
  const rows = getDb()
    .prepare(
      `SELECT lecture_id FROM transcripts
        WHERE status = 'done' AND summary IS NULL AND text IS NOT NULL AND length(text) > 200
        LIMIT ?`,
    )
    .all(MAX_NOTES_PER_RUN) as { lecture_id: string }[];

  let done = 0;
  for (const r of rows) {
    try {
      await generateLectureNotes(r.lecture_id);
      done++;
    } catch (e) {
      app.log.warn(`Notes ${r.lecture_id}: ${String(e)}`);
    }
  }
  if (done) app.log.info(`Wrote study notes for ${done} lecture${done === 1 ? "" : "s"}`);
  return done;
}

/** Should this lecture be attempted now, or has it earned a rest? */
function isDue(l: LectureRow): boolean {
  // A class that hasn't happened yet cannot have a recording. Checking costs a
  // browser and half a minute of waiting, every single sync, to learn nothing.
  if (l.recorded_at && Date.parse(l.recorded_at) > Date.now()) return false;

  if (!l.status) return true; // never attempted
  const since = l.updated_at ? Date.now() - Date.parse(`${l.updated_at}Z`) : Infinity;
  if (!Number.isFinite(since)) return true;

  // Mid-flight: either a live attempt to stay out of the way of, or the wreckage
  // of one that was interrupted.
  if (l.status === "downloading" || l.status === "transcribing") {
    return since > IN_FLIGHT_TIMEOUT_MS;
  }
  if (l.status === "error") return since > RETRY_ERROR_MS;
  if (l.status === "no_recording") {
    const age = l.recorded_at ? Date.now() - Date.parse(l.recorded_at) : 0;
    // A class from last week may still be published; one from March won't be.
    return age > STALE_LECTURE_DAYS * 864e5 ? since > RETRY_STALE_MS : since > RETRY_PENDING_MS;
  }
  return since > RETRY_PENDING_MS;
}

/**
 * Did this fail because of the lecture, or because the machinery went away?
 *
 * A browser killed by a restart, a closed lid or a dropped connection says
 * nothing about whether the recording is transcribable. Recording it as an
 * error would put the lecture in the two-hour sin bin for something that wasn't
 * its fault, so these get retried on the next pass instead.
 */
function isInfrastructureFailure(message: string): boolean {
  return /has been closed|Target closed|browserContext|browser.*disconnected|ECONNRESET|ENOTFOUND|socket hang up|net::ERR/i.test(
    message,
  );
}

type Outcome = "transcribed" | "waiting";
type EchoContext = Awaited<ReturnType<typeof acquireEchoContext>>["ctx"];

/**
 * One lecture, cheapest route first: text we can extract > captions someone else
 * already wrote > audio we transcribe ourselves.
 */
async function transcribeOne(
  app: FastifyInstance,
  lecture: LectureRow,
  echoCtx: EchoContext | null,
): Promise<Outcome> {
  const source = lecture.media_url ?? lecture.url ?? "";
  const isDocument =
    lecture.provider === "slides" || /\.(pdf|pptx?|docx?)($|\?)/i.test(source);

  // --- Slide decks and handouts filed as lectures -------------------------
  if (isDocument && source) {
    setStatus(lecture.id, "transcribing");
    // The course-file library has very likely downloaded and read this exact
    // deck already. Reusing that costs nothing and works offline.
    const text = storedText(source) ?? (await extractSlideText(withCurrentToken(source)));
    if (!text || text.trim().length < 40) {
      // Nothing readable in it — not a failure, just nothing to say.
      setStatus(lecture.id, "no_recording");
      return "waiting";
    }
    setDone(lecture.id, text, null);
    await generateLectureNotes(lecture.id);
    app.log.info(`Transcript ${lecture.id}: extracted text from ${lecture.provider}`);
    return "transcribed";
  }

  // --- Echo360 recordings --------------------------------------------------
  if (lecture.provider === "echo360") {
    if (!echoCtx) {
      // Nothing to record against — leave the row untouched so the retry clock
      // isn't reset by a run that never actually tried.
      return "waiting";
    }
    const lessonId = echoLessonId(lecture.id);
    const probe = await probeClassroom(echoCtx, lessonId);

    // Captions the player itself loaded, or any the API will hand over.
    const captions =
      probe.transcript ?? (await fetchAnyTranscript(echoCtx, lessonId, probe.mediaIds));
    if (captions && captions.length > 40) {
      setDone(lecture.id, captions, null);
      await generateLectureNotes(lecture.id);
      app.log.info(`Transcript ${lecture.id}: used Echo360 captions`);
      return "transcribed";
    }

    if (!probe.manifest) {
      setStatus(lecture.id, "no_recording");
      return "waiting";
    }
    return whisper(app, lecture.id, probe.manifest.url, probe.manifest.headers);
  }

  // --- A local file we already have ----------------------------------------
  if (lecture.media_path && existsSync(lecture.media_path)) {
    return whisper(app, lecture.id, lecture.media_path);
  }

  // --- A plain media URL ---------------------------------------------------
  if (/\.(mp4|m4a|mp3|wav|m3u8|webm|mov)($|\?)/i.test(source)) {
    return whisper(app, lecture.id, source);
  }

  // Nothing we know how to open. Say so rather than retrying it forever.
  setStatus(lecture.id, "no_recording");
  return "waiting";
}

/** Download, convert and transcribe — the expensive path, used last. */
async function whisper(
  app: FastifyInstance,
  lectureId: string,
  source: string,
  headers?: Record<string, string>,
): Promise<Outcome> {
  if (!hasApiKey()) {
    setStatus(lectureId, "no_recording");
    return "waiting";
  }
  setStatus(lectureId, "downloading");
  const dir = join(dataDir(), "media");
  mkdirSync(dir, { recursive: true });
  const mp3 = join(dir, `${lectureId.replace(/[^\w.-]/g, "_")}.mp3`);
  await extractAudioMp3(source, mp3, headers);

  setStatus(lectureId, "transcribing");
  const { text, segments } = await transcribeFile(mp3);
  const clean = await cleanTranscript(text).catch(() => text);
  setDone(lectureId, clean, segments);
  await generateLectureNotes(lectureId);
  app.log.info(`Transcript ${lectureId}: transcribed from audio`);
  return "transcribed";
}

/** `echo360:<lessonId>` — the id scheme the Echo sync writes. */
function echoLessonId(lectureId: string): string {
  return lectureId.replace(/^echo360:/, "");
}

/**
 * Text the course-file sync already extracted from this same file.
 *
 * Moodle surfaces the same PDF twice — once as a "lecture" and once as a course
 * file — under different URLs, so they can't be matched on the link. The
 * filename is what they share.
 */
function storedText(url: string): string | null {
  const name = decodeURIComponent((url.split("?")[0] ?? "").split("/").pop() ?? "");
  if (name.length < 4) return null;
  const row = getDb()
    .prepare(
      "SELECT text FROM materials WHERE title = ? AND text IS NOT NULL AND length(text) > 200 LIMIT 1",
    )
    .get(name) as { text: string } | undefined;
  return row?.text ?? null;
}

/**
 * Moodle file links are only good with a web-services token attached, and the
 * one stored on the row was minted whenever that lecture was first seen. Swap in
 * the token we hold now so a link that's been sitting in the database for a
 * month still opens.
 */
function withCurrentToken(url: string): string {
  const stripped = url.replace(/([?&])token=[^&]*/i, "$1").replace(/[?&]$/, "");
  return withToken(stripped) ?? url;
}

function setStatus(lectureId: string, status: string): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (id, lecture_id, status) VALUES (?,?,?)
       ON CONFLICT(lecture_id) DO UPDATE SET status=excluded.status, error=NULL, updated_at=datetime('now')`,
    )
    .run("tr:" + lectureId, lectureId, status);
}

/**
 * Store the transcript AND stamp updated_at — the retry clock reads that column,
 * so a write that forgets it makes the row look permanently overdue.
 */
export function setDone(lectureId: string, text: string, segments: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (id, lecture_id, status, text, segments) VALUES (?,?,'done',?,?)
       ON CONFLICT(lecture_id) DO UPDATE SET status='done', text=excluded.text,
         segments=COALESCE(excluded.segments, transcripts.segments),
         error=NULL, updated_at=datetime('now')`,
    )
    .run("tr:" + lectureId, lectureId, text, segments ? JSON.stringify(segments) : null);
}

/** Forget an interrupted attempt entirely, so nothing is held against it. */
function clearStatus(lectureId: string): void {
  getDb().prepare("DELETE FROM transcripts WHERE lecture_id = ? AND text IS NULL").run(lectureId);
}

function setError(lectureId: string, err: string): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (id, lecture_id, status, error) VALUES (?,?,'error',?)
       ON CONFLICT(lecture_id) DO UPDATE SET status='error', error=excluded.error, updated_at=datetime('now')`,
    )
    .run("tr:" + lectureId, lectureId, err.slice(0, 500));
}
