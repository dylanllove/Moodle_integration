import type { FastifyInstance } from "fastify";
import { getDb, getSetting, setSetting } from "@uni/db";
import {
  loginEcho360,
  echoConnected,
  echoVerify,
  acquireEchoContext,
  persistEchoSession,
  clearEchoSession,
  listLessons,
  withEchoLock,
  discoverEchoSections,
} from "@uni/lms";
import { indexAll } from "@uni/ai";
import { backfillTranscripts } from "../transcripts.js";

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

/** Does this course want its recordings pulled down at all? */
function wantsLectures(courseId: string): boolean {
  const row = getDb()
    .prepare("SELECT excluded, sync_lectures FROM courses WHERE id = ?")
    .get(courseId) as { excluded: number; sync_lectures: number } | undefined;
  // A section mapped to nothing we know about is left alone rather than dropped.
  if (!row) return true;
  return row.excluded === 0 && row.sync_lectures === 1;
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
    // How the saved session is actually holding up, rather than just whether a
    // file exists. `wobbly` means it was refused but hasn't been given up on.
    session: {
      failures: echoFailureCount(),
      wobbly: echoFailureCount() > 0,
      lastWarm: getSetting("echo360_last_warm"),
    },
  }));

  /** Touch Echo360 now and report whether the saved session still works. */
  app.post("/api/echo360/keepalive", async () => {
    const { keepEchoSessionWarm } = await import("@uni/lms");
    const r = await keepEchoSessionWarm();
    if (r.ok) {
      setSetting("echo360_last_warm", new Date().toISOString());
      clearEchoFailures();
    }
    return r;
  });

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

  /**
   * Work out each active course's Echo360 section by itself, so nobody has to go
   * hunting for a GUID.
   *
   * Discovery wins on any section it recognises — it derives the course from the
   * Moodle link it launched, which is the one source that can't drift the way a
   * hand-typed mapping can. Sections it didn't find are left exactly as they were,
   * so a manually added one never gets dropped.
   */
  app.post<{ Body?: { apply?: boolean } }>("/api/echo360/discover", async (req, reply) => {
    if (!echoConnected())
      return reply
        .code(400)
        .send({ error: "Not connected to Echo360 — click Connect Echo360 and log in once." });

    let result;
    try {
      result = await discoverEchoSections();
    } catch (e) {
      if (String(e).includes("ECHO_SESSION_EXPIRED"))
        return reply.code(401).send({ error: "Your Echo360 session has expired — reconnect and try again.", expired: true });
      return reply.code(400).send({ error: String(e) });
    }

    if (req.body?.apply === false) return { ok: true, ...result, sections: sections() };

    const merged = new Map(sections().map((s) => [s.sectionId, s] as const));
    let changed = 0;
    for (const d of result.found) {
      const before = merged.get(d.sectionId);
      if (before?.courseId !== d.courseId || before?.label !== d.label) changed++;
      merged.set(d.sectionId, { sectionId: d.sectionId, courseId: d.courseId, label: d.label });
    }
    setSetting("echo360_sections", JSON.stringify([...merged.values()]));
    app.log.info(`Echo360 discovery: ${result.found.length} section(s), ${changed} updated.`);
    return { ok: true, ...result, changed, sections: sections() };
  });

  /**
   * Discover every lesson in every configured section and file it as a lecture.
   *
   * Transcription itself lives in the shared backfill engine, so an Echo lesson,
   * an uploaded recording and a Moodle slide deck all go through one path and
   * all get notes and a flashcard deck at the end of it. This route only has to
   * answer "what exists?".
   */
  app.post("/api/echo360/sync", async (_req, reply) => {
    const secs = sections();
    if (!secs.length) return reply.code(400).send({ error: "No Echo360 sections configured." });

    if (!echoConnected())
      return reply
        .code(400)
        .send({ error: "Not connected to Echo360 — click Connect Echo360 and log in once." });

    const counts = { lessons: 0, sections: 0, failed: 0, skipped: 0 };
    let expired = false;

    const discovery = await withEchoLock(async () => {
      const acquired = await acquireEchoContext().catch(() => null);
      if (!acquired) return { ok: false as const, error: "Not connected to Echo360." };
      const { ctx, done: cleanup } = acquired;
      try {
        for (const sec of secs) {
          // A section mapped to a course the student has switched off, or
          // deleted, is skipped before any network work happens.
          if (sec.courseId && !wantsLectures(sec.courseId)) {
            counts.skipped++;
            continue;
          }
          let lessons;
          try {
            lessons = await listLessons(ctx, sec.sectionId);
            counts.sections++;
          } catch (e) {
            if (String(e).includes("ECHO_SESSION_EXPIRED")) {
              expired = true;
              break;
            }
            counts.failed++;
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
          }
        }
      } catch (e) {
        app.log.error(`Echo360 sync: ${String(e)}`);
      } finally {
        // Refresh the saved session (cookies rotate on every authenticated
        // request) so the next run starts from the newest one we've seen.
        await persistEchoSession(ctx).catch(() => {});
        await cleanup();
      }
      return { ok: true as const };
    });

    if (!discovery.ok) return reply.code(400).send({ error: discovery.error });

    if (expired) {
      noteEchoFailure();
      if (echoFailureCount() >= EXPIRY_STRIKES) clearEchoSession();
      return reply.code(401).send({
        error:
          echoFailureCount() >= EXPIRY_STRIKES
            ? "Your Echo360 session has expired — click Connect Echo360 to log in again."
            : "Echo360 didn't accept the saved session this time; retrying on the next sync.",
        expired: true,
      });
    }
    clearEchoFailures();

    // Now fetch whatever transcripts are outstanding — Echo's own captions where
    // they exist, our own transcription where they don't.
    const transcripts = await backfillTranscripts(app);

    try {
      indexAll();
    } catch {
      /* non-fatal */
    }
    return { ok: true, counts: { ...counts, ...transcripts } };
  });
}

/**
 * Echo360 hands back a login redirect for reasons that have nothing to do with
 * your credentials — a slow SSO round trip, a node that hasn't caught up. The
 * old code deleted the saved session the first time it saw one, which is how a
 * transient blip turned into "log in again". It now takes repeated refusals.
 */
const EXPIRY_STRIKES = 3;

function echoFailureCount(): number {
  return Number(getSetting("echo360_auth_failures") ?? "0") || 0;
}
function noteEchoFailure(): void {
  setSetting("echo360_auth_failures", String(echoFailureCount() + 1));
}
function clearEchoFailures(): void {
  if (echoFailureCount() !== 0) setSetting("echo360_auth_failures", "0");
}
