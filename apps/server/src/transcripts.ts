import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { getDb, dataDir, getSetting, type Lecture, type TranscriptSegment, type TranscriptSource } from "@uni/db";
import {
  canTranscribe,
  extractAudioMp3,
  probeDuration,
  resolveMediaSource,
  transcribeFile,
  TranscriptionDeferred,
} from "@uni/transcribe";
import { ANALYSIS_VERSION, canComplete, cleanTranscript } from "@uni/ai";
import {
  acquireEchoContext,
  echoConnected,
  fetchAnyTranscript,
  probeClassroom,
  withEchoLock,
  withToken,
  type Captions,
} from "@uni/lms";
import { extractFilePages, extractSlidePages, type SlidePage } from "./extract.js";
import { generateLectureNotes } from "./notes-gen.js";
import { storedFile } from "./repair.js";

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
/** Lectures whose notes failed recently, so they don't take every backfill slot. */
const noteFailedAt = new Map<string, number>();
const NOTES_RETRY_MS = 6 * 3600_000;
/** Notes are a single cheap call each, so a few more per run is fine. */
const MAX_NOTES_PER_RUN = 8;
/**
 * Captions shorter than this are a partial cue window the player loaded, not the
 * lecture — accepting one used to leave a 179-character "transcript" marked done
 * forever. Below it, the audio is transcribed instead (free, when local).
 */
const MIN_CAPTION_CHARS = 1500;
/** How long before a failed attempt is worth repeating. */
const RETRY_ERROR_MS = 2 * 3600_000;
/** An unpublished recording, while the class is still recent. */
const RETRY_PENDING_MS = 30 * 60_000;
/** Once a lecture is this old, an absent recording is probably permanent. */
const STALE_LECTURE_DAYS = 14;
const RETRY_STALE_MS = 24 * 3600_000;
/** A recording that exists but is silent (a dead room mic) won't fix itself soon. */
const RETRY_SILENT_MS = 7 * 24 * 3600_000;
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
  error: string | null;
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
              l.recorded_at, t.status, t.error, t.updated_at
         FROM lectures l
         LEFT JOIN transcripts t ON t.lecture_id = l.id
         LEFT JOIN courses c ON c.id = l.course_id
        WHERE (t.status IS NULL OR t.status <> 'done')
          AND (l.course_id IS NULL OR (c.excluded = 0 AND c.sync_lectures = 1))
        ORDER BY l.recorded_at IS NULL, l.recorded_at DESC`,
    )
    .all() as unknown as LectureRow[];

  // "Waiting for a local model" is only worth another look once there is one.
  const audioReady = await canTranscribe();
  const due = rows.filter((r) => (r.status === "needs_local" ? audioReady : isDue(r)));
  if (due.length > MAX_PER_RUN) out.deferred = due.length - MAX_PER_RUN;
  const batch = due.slice(0, MAX_PER_RUN);

  const runBatch = async (echoCtx: EchoContext | null): Promise<void> => {
    for (const lecture of batch) {
      // Someone pressed Transcribe on this one while the sync was on its way.
      if (inFlight.has(lecture.id)) continue;
      out.attempted++;
      active.add(lecture.id);
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
      } finally {
        active.delete(lecture.id);
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
  if (!(await canComplete())) return 0;
  // Missing notes, and notes from before the structured analysis (or an older
  // version of it) — the latter is how existing lectures get their rows.
  const rows = getDb()
    .prepare(
      `SELECT t.lecture_id FROM transcripts t
         LEFT JOIN lecture_digests d ON d.lecture_id = t.lecture_id
        WHERE t.status = 'done' AND t.text IS NOT NULL AND length(t.text) > 200
          AND (d.lecture_id IS NULL OR d.schema_version < ?)
        ORDER BY t.summary IS NOT NULL, t.updated_at DESC`,
    )
    .all(ANALYSIS_VERSION) as { lecture_id: string }[];
  const now = Date.now();
  const batch = rows
    .filter((r) => now - (noteFailedAt.get(r.lecture_id) ?? 0) > NOTES_RETRY_MS)
    .slice(0, MAX_NOTES_PER_RUN);

  let done = 0;
  for (const r of batch) {
    try {
      await generateLectureNotes(r.lecture_id);
      noteFailedAt.delete(r.lecture_id);
      done++;
    } catch (e) {
      noteFailedAt.set(r.lecture_id, Date.now());
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
  // The budget resets monthly and can be raised any time; once a day is plenty.
  if (l.status === "over_budget") return since > RETRY_STALE_MS;
  if (l.status === "no_recording" && l.error?.startsWith("No speech")) return since > RETRY_SILENT_MS;
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
 * already wrote > audio we transcribe ourselves (on this machine if possible).
 *
 * `sniff` also lets it open an unrecognised player page in the browser to find
 * the stream — too slow to do for every lecture on every sync, but right when a
 * student has asked for this one.
 */
async function transcribeOne(
  app: FastifyInstance,
  lecture: LectureRow,
  echoCtx: EchoContext | null,
  opts: { sniff?: boolean } = {},
): Promise<Outcome> {
  const source = lecture.media_url ?? lecture.url ?? "";
  const isDocument =
    lecture.provider === "slides" || /\.(pdf|pptx?|docx?)($|\?)/i.test(source);

  // --- Slide decks and handouts filed as lectures -------------------------
  if (isDocument && source) {
    setStatus(lecture.id, "transcribing");
    // The course-file library has very likely downloaded this exact deck
    // already. Reading it from disk costs nothing and works offline.
    const stored = storedFile(source);
    const pages: SlidePage[] = stored
      ? await extractFilePages(stored.path, stored.mimetype ?? "").catch(() => [])
      : await extractSlidePages(withCurrentToken(source)).catch(() => []);
    const text = pages.map((p) => p.text).join("\n\n");
    if (text.trim().length < 40) {
      // Nothing readable in it — not a failure, just nothing to say.
      setStatus(lecture.id, "no_recording");
      return "waiting";
    }
    const segments: TranscriptSegment[] = pages.map((p) => ({ start: 0, end: 0, page: p.page, text: p.text }));
    setDone(lecture.id, text, segments, { source: "slides" });
    await notesFor(app, lecture.id);
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
    const captions = best(probe.transcript, await fetchAnyTranscript(echoCtx, lessonId, probe.mediaIds));
    if (captions && captions.text.length >= MIN_CAPTION_CHARS) {
      setDone(lecture.id, captions.text, captions.segments, { source: "captions" });
      await notesFor(app, lecture.id);
      app.log.info(`Transcript ${lecture.id}: used Echo360 captions`);
      return "transcribed";
    }

    if (!probe.manifest) {
      setStatus(lecture.id, "no_recording");
      return "waiting";
    }
    return whisper(app, lecture, probe.manifest.url, probe.manifest.headers);
  }

  // --- A local file we already have ----------------------------------------
  if (lecture.media_path && existsSync(lecture.media_path)) {
    return whisper(app, lecture, lecture.media_path);
  }

  // --- A plain media URL ---------------------------------------------------
  if (/\.(mp4|m4a|mp3|wav|m3u8|webm|mov)($|\?)/i.test(source)) {
    return whisper(app, lecture, source);
  }

  // --- Some other player page, when asked for by hand ----------------------
  if (opts.sniff && source) {
    setStatus(lecture.id, "downloading");
    const media = await resolveMediaSource(lecture as unknown as Lecture);
    return whisper(app, lecture, media.input, media.headers);
  }

  // Nothing we know how to open. Say so rather than retrying it forever.
  setStatus(lecture.id, "no_recording");
  return "waiting";
}

/**
 * Notes for a transcript that has just been saved. A failure here — the budget
 * running out, a network blip, a model returning nonsense — must not reach the
 * caller's error handling, which would mark the finished transcript as failed
 * and have the whole recording downloaded and transcribed again. The notes
 * backfill picks the lecture up on a later run instead.
 */
async function notesFor(app: FastifyInstance, lectureId: string): Promise<void> {
  try {
    await generateLectureNotes(lectureId);
  } catch (e) {
    noteFailedAt.set(lectureId, Date.now());
    app.log.warn(`Notes ${lectureId}: ${e instanceof Error ? e.message : String(e)} — will retry later`);
  }
}

function best(a: Captions | null, b: Captions | null): Captions | null {
  if (!a) return b;
  if (!b) return a;
  return b.text.length > a.text.length ? b : a;
}

/**
 * Download, convert and transcribe — the expensive path, used last.
 *
 * Audio already on disk from an earlier attempt is reused rather than pulled
 * down again, and removed once the transcript is safely stored (unless the
 * student has asked to keep recordings).
 */
async function whisper(
  app: FastifyInstance,
  lecture: LectureRow,
  source: string,
  headers?: Record<string, string>,
): Promise<Outcome> {
  const lectureId = lecture.id;
  const dir = join(dataDir(), "media");
  mkdirSync(dir, { recursive: true });
  const isLocalFile = !/^https?:/i.test(source) && existsSync(source);
  const mp3 = /\.mp3$/i.test(source) && isLocalFile ? source : join(dir, `${lectureId.replace(/[^\w.-]/g, "_")}.mp3`);

  if (!existsSync(mp3) || statSync(mp3).size === 0) {
    setStatus(lectureId, "downloading");
    await extractAudioMp3(source, mp3, headers);
  }
  // A download that stopped early looks exactly like a short lecture, and would be
  // transcribed, noted and carded as one. Echo ids carry the class's scheduled
  // times, so anything far shorter than the class is a failed download instead.
  // If a fresh download comes back exactly as short as last time, though, the
  // recording itself is short (the lecturer stopped it early) and it's used.
  const got = await probeDuration(mp3);
  const expected = scheduledSeconds(lectureId);
  if (got != null && expected && got < Math.min(expected * 0.3, 15 * 60)) {
    const short = `The recording only downloaded ${Math.round(got)}s of a ${Math.round(expected / 60)}-minute class`;
    if (!lecture.error?.startsWith(short)) {
      rmSync(mp3, { force: true });
      throw new Error(`${short} — will retry.`);
    }
  }

  // Audio in the media folder is the app's own working copy, and goes once it's
  // done with. Remember a fetched recording so a retry reuses it — but a
  // student's upload keeps pointing at their original file.
  const ours = mp3.startsWith(dir);
  const remember = ours && lecture.provider !== "upload";
  getDb()
    .prepare(
      `UPDATE lectures SET duration_sec = COALESCE(?, duration_sec)${remember ? ", media_path = ?" : ""} WHERE id = ?`,
    )
    .run(...(remember ? [got, mp3, lectureId] : [got, lectureId]));
  const discardAudio = () => {
    if (!ours) return;
    rmSync(mp3, { force: true });
    if (remember) getDb().prepare("UPDATE lectures SET media_path = NULL WHERE id = ?").run(lectureId);
  };

  setStatus(lectureId, "transcribing");
  let result;
  try {
    result = await transcribeFile(mp3);
  } catch (e) {
    if (e instanceof TranscriptionDeferred) {
      // Silent audio will be fetched again if it's ever retried; don't keep it.
      if (e.reason === "no_recording") discardAudio();
      setStatus(lectureId, e.reason, e.message);
      app.log.info(`Transcript ${lectureId}: ${e.reason} — ${e.message}`);
      return "waiting";
    }
    throw e;
  }
  setDone(lectureId, result.text, result.segments, {
    source: lecture.provider === "upload" ? "upload" : result.source,
    model: result.model,
    speechSec: result.speechSec,
  });
  // The tidied read-through, when asked for, is kept beside the transcript
  // rather than over it: `text` has to stay word-for-word what the segments
  // say, or timestamps and search stop lining up with it.
  const tidy = await cleanTranscript(result.text).catch(() => result.text);
  if (tidy !== result.text) {
    getDb().prepare("UPDATE transcripts SET clean_text = ? WHERE lecture_id = ?").run(tidy, lectureId);
  }

  // The transcript is the durable thing; a recording's audio is 10–30 MB that
  // nothing reads again.
  if (getSetting("keep_audio") !== "true") discardAudio();

  await notesFor(app, lectureId);
  app.log.info(`Transcript ${lectureId}: transcribed from audio (${result.source})`);
  return "transcribed";
}

/**
 * Transcribe one lecture now, because a student asked — the same route as the
 * background sync, including captions first and the Echo360 lock, rather than a
 * second pipeline that drifts from it.
 */
const inFlight = new Map<string, Promise<void>>();
/** The lecture the background sync is working on right now, if any. */
const active = new Set<string>();

export function transcribeLectureNow(app: FastifyInstance, lectureId: string): { queued: boolean } {
  // Already being done — by an earlier click, or by the sync. Either way it's
  // on its way, and a second attempt would race it for the same audio file.
  if (inFlight.has(lectureId) || active.has(lectureId)) return { queued: true };
  const lecture = getDb()
    .prepare(
      `SELECT l.id, l.course_id, l.title, l.provider, l.url, l.media_url, l.media_path,
              l.recorded_at, t.status, t.error, t.updated_at
         FROM lectures l LEFT JOIN transcripts t ON t.lecture_id = l.id WHERE l.id = ?`,
    )
    .get(lectureId) as LectureRow | undefined;
  if (!lecture) return { queued: false };
  setStatus(lectureId, "pending");

  const job = (async () => {
    const run = (ctx: EchoContext | null) => transcribeOne(app, lecture, ctx, { sniff: true });
    try {
      if (lecture.provider === "echo360") {
        await withEchoLock(async () => {
          const echo = await acquireEchoContext().catch(() => null);
          try {
            if (!echo) throw new Error("Echo360 isn't connected — sign in from Settings first.");
            await run(echo.ctx);
          } finally {
            if (echo) await echo.done().catch(() => {});
          }
        });
      } else {
        await run(null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(lectureId, message);
      app.log.warn(`Transcript ${lectureId}: ${message}`);
    }
  })().finally(() => inFlight.delete(lectureId));
  inFlight.set(lectureId, job);
  return { queued: true };
}

export function transcribingNow(): string[] {
  return [...inFlight.keys()];
}

/** The class length an Echo lesson id encodes (`…_<start>_<end>`), in seconds. */
function scheduledSeconds(lectureId: string): number | null {
  const m = /_(\d{4}-\d\d-\d\dT[\d:.]+)_(\d{4}-\d\d-\d\dT[\d:.]+)$/.exec(lectureId);
  if (!m) return null;
  const sec = (Date.parse(m[2]!) - Date.parse(m[1]!)) / 1000;
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/** `echo360:<lessonId>` — the id scheme the Echo sync writes. */
function echoLessonId(lectureId: string): string {
  return lectureId.replace(/^echo360:/, "");
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

/** `note` is shown to the student for statuses that need them to do something. */
function setStatus(lectureId: string, status: string, note: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (id, lecture_id, status, error) VALUES (?,?,?,?)
       ON CONFLICT(lecture_id) DO UPDATE SET status=excluded.status, error=excluded.error, updated_at=datetime('now')`,
    )
    .run("tr:" + lectureId, lectureId, status, note);
}

/**
 * Store the transcript AND stamp updated_at — the retry clock reads that column,
 * so a write that forgets it makes the row look permanently overdue.
 */
export function setDone(
  lectureId: string,
  text: string,
  segments: TranscriptSegment[] | null,
  meta: { source: TranscriptSource; model?: string | null; speechSec?: number | null },
): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (id, lecture_id, status, text, segments, source, model, speech_sec)
       VALUES (?,?,'done',?,?,?,?,?)
       ON CONFLICT(lecture_id) DO UPDATE SET status='done', text=excluded.text,
         segments=COALESCE(excluded.segments, transcripts.segments),
         source=excluded.source, model=excluded.model, speech_sec=excluded.speech_sec,
         error=NULL, updated_at=datetime('now')`,
    )
    .run(
      "tr:" + lectureId,
      lectureId,
      text,
      segments?.length ? JSON.stringify(segments) : null,
      meta.source,
      meta.model ?? null,
      meta.speechSec ?? null,
    );
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
