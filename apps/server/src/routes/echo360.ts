import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getDb, getSetting, setSetting, dataDir } from "@uni/db";
import {
  loginEcho360,
  echoConnected,
  echoVerify,
  acquireEchoContext,
  persistEchoSession,
  clearEchoSession,
  listLessons,
  fetchTranscript,
  sniffAudioManifest,
  withEchoLock,
} from "@uni/lms";
import { extractAudioMp3, transcribeFile } from "@uni/transcribe";
import { cleanTranscript, indexAll } from "@uni/ai";
import { generateLectureNotes } from "../notes-gen.js";

interface Section {
  sectionId: string;
  courseId: string | null;
  label?: string;
}

/** Make Echo titles distinguishable: drop the "CODE-SEM-Comp-" prefix, add the date. */
function niceEchoTitle(raw: string, start: string | null): string {
  const name = raw.replace(/^[A-Z]{2,4}\d{3}-\d{2}[A-Z]\d-[A-Za-z]+-?/, "").trim() || raw;
  if (!start) return name;
  const d = new Date(start).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${name} · ${d}`;
}

function sections(): Section[] {
  try {
    return JSON.parse(getSetting("echo360_sections") ?? "[]");
  } catch {
    return [];
  }
}

export async function registerEcho360Routes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Optionally seed sections from env (ECHO360_SECTIONS = JSON array). Nothing
  // personal is hardcoded — friends add their own sections via the UI/env.
  if (!getSetting("echo360_sections") && process.env.ECHO360_SECTIONS) {
    setSetting("echo360_sections", process.env.ECHO360_SECTIONS);
  }

  app.get("/api/echo360/status", async () => ({
    connected: echoConnected(),
    instanceId: getSetting("echo360_instance_id"),
    sections: sections(),
  }));

  app.post("/api/echo360/login", async () => loginEcho360());

  // Called after the user logs in ("I've connected"). On success, immediately
  // kick off downloading + transcribing in the background.
  app.post("/api/echo360/verify", async () => {
    const res = await echoVerify();
    if (res.connected) {
      app.log.info("Echo360 connected — starting background lecture sync.");
      void app.inject({ method: "POST", url: "/api/echo360/sync" }).catch(() => {});
    }
    return res;
  });

  // Manage which Echo360 sections to pull, and which course each maps to.
  app.put<{ Body: { instanceId?: string; sections?: Section[] } }>("/api/echo360/config", async (req) => {
    if (req.body.instanceId != null) setSetting("echo360_instance_id", req.body.instanceId);
    if (req.body.sections) setSetting("echo360_sections", JSON.stringify(req.body.sections));
    return { ok: true, sections: sections() };
  });

  // Pull all lessons for every configured section: transcript API first, else
  // download audio and transcribe. Everything lands as course-linked lectures.
  app.post("/api/echo360/sync", async (_req, reply) => {
    const secs = sections();
    if (!secs.length) return reply.code(400).send({ error: "No Echo360 sections configured." });

    if (!echoConnected())
      return reply
        .code(400)
        .send({ error: "Not connected to Echo360 — click Connect Echo360 and log in once." });

    const counts = { lessons: 0, transcribed: 0, noRecording: 0, failed: 0 };
    let expired = false;
    return withEchoLock(async () => {
    const acquired = await acquireEchoContext().catch(() => null);
    if (!acquired) return reply.code(400).send({ error: "Not connected to Echo360." });
    const { ctx, done: cleanup } = acquired;
    try {
      for (const sec of secs) {
        let lessons;
        try {
          lessons = await listLessons(ctx, sec.sectionId);
        } catch (e) {
          if (String(e).includes("ECHO_SESSION_EXPIRED")) {
            expired = true;
            break;
          }
          app.log.warn(`Echo360 section ${sec.sectionId}: ${String(e)}`);
          continue;
        }
        for (const l of lessons) {
          const id = `echo360:${l.lessonId}`;
          const title = niceEchoTitle(l.title, l.start);
          db.prepare(
            `INSERT INTO lectures (id, course_id, title, url, provider, recorded_at)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, course_id=excluded.course_id, updated_at=datetime('now')`,
          ).run(id, sec.courseId, title, `https://echo360.net.au/lesson/${l.lessonId}/classroom`, "echo360", l.start);
          counts.lessons++;

          // Also surface the lecture's scheduled time on the calendar/timetable.
          if (l.start) {
            db.prepare(
              `INSERT INTO events (id, course_id, title, kind, source, start_at, end_at, url)
               VALUES (?,?,?,'class','echo360',?,?,?)
               ON CONFLICT(id) DO UPDATE SET title=excluded.title, start_at=excluded.start_at, end_at=excluded.end_at, updated_at=datetime('now')`,
            ).run(`echo-evt:${l.lessonId}`, sec.courseId, l.title, l.start, l.end, `https://echo360.net.au/lesson/${l.lessonId}/classroom`);
          }

          const done = db.prepare("SELECT status FROM transcripts WHERE lecture_id = ?").get(id) as
            | { status: string }
            | undefined;
          if (done?.status === "done") continue;

          try {
            const res = await processLesson(app, ctx, id, l.lessonId, l.mediaId);
            if (res === "transcribed") counts.transcribed++;
            else counts.noRecording++;
          } catch (e) {
            counts.failed++;
            db.prepare(
              `INSERT INTO transcripts (id, lecture_id, status, error) VALUES (?,?,?,?)
               ON CONFLICT(lecture_id) DO UPDATE SET status='error', error=excluded.error, updated_at=datetime('now')`,
            ).run("tr:" + id, id, "error", String(e));
          }
        }
      }
    } catch (e) {
      app.log.error(`Echo360 sync: ${String(e)}`);
    } finally {
      // Refresh the saved session (tokens may have rotated), then clean up.
      await persistEchoSession(ctx).catch(() => {});
      await cleanup();
    }

    if (expired) {
      clearEchoSession();
      return reply
        .code(401)
        .send({ error: "Your Echo360 session has expired — click Connect Echo360 to log in again." });
    }
    try {
      indexAll();
    } catch {
      /* non-fatal */
    }
    return { ok: true, counts };
    });
  });
}

type LessonResult = "transcribed" | "no_recording";

type EchoCtx = Awaited<ReturnType<typeof acquireEchoContext>>["ctx"];

async function processLesson(
  app: FastifyInstance,
  ctx: EchoCtx,
  lectureId: string,
  lessonId: string,
  mediaId: string | null,
): Promise<LessonResult> {
  const db = getDb();
  const mark = (status: string) =>
    db.prepare(
      `INSERT INTO transcripts (id, lecture_id, status) VALUES (?,?,?)
       ON CONFLICT(lecture_id) DO UPDATE SET status=excluded.status, error=NULL, updated_at=datetime('now')`,
    ).run("tr:" + lectureId, lectureId, status);

  // 1. Existing captions (fast, free).
  if (mediaId) {
    const t = await fetchTranscript(ctx, lessonId, mediaId).catch(() => null);
    if (t && t.length > 40) {
      db.prepare(
        `INSERT INTO transcripts (id, lecture_id, status, text) VALUES (?,?,?,?)
         ON CONFLICT(lecture_id) DO UPDATE SET status='done', text=excluded.text, error=NULL, updated_at=datetime('now')`,
      ).run("tr:" + lectureId, lectureId, "done", t);
      app.log.info(`Echo360 ${lessonId}: used existing captions`);
      return "transcribed";
    }
  }

  // 2. Try to capture the recording stream.
  const manifest = await sniffAudioManifest(ctx, lessonId);
  if (!manifest) {
    // No stream = the class hasn't been recorded/published yet (common early in
    // term). That's expected, not a failure — mark soft so it retries later.
    mark("no_recording");
    app.log.info(`Echo360 ${lessonId}: no recording available yet`);
    return "no_recording";
  }

  // A stream exists — from here, any problem IS a real failure.
  mark("downloading");
  const dir = join(dataDir(), "media");
  mkdirSync(dir, { recursive: true });
  const mp3 = join(dir, `${lectureId.replace(/[^\w.-]/g, "_")}.mp3`);
  await extractAudioMp3(manifest.url, mp3, manifest.headers);

  mark("transcribing");
  const { text, segments } = await transcribeFile(mp3);
  const clean = await cleanTranscript(text).catch(() => text);
  db.prepare(
    `UPDATE transcripts SET status='done', text=?, segments=?, error=NULL, updated_at=datetime('now') WHERE lecture_id=?`,
  ).run(clean, JSON.stringify(segments), lectureId);
  await generateLectureNotes(lectureId);
  app.log.info(`Echo360 ${lessonId}: transcribed + cleaned + noted`);
  return "transcribed";
}
