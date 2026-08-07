import type { FastifyInstance } from "fastify";
import { rmSync } from "node:fs";
import { getDb } from "@uni/db";

/** Read endpoints for courses, assignments, lectures, notes and events. */
export async function registerCoreRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * Courses, with what each one is actually costing.
   *
   * The counts are here so "delete the ones that don't matter" is an informed
   * decision rather than a leap: a notice board with 40 files and 12 recordings
   * is worth removing, and one with nothing in it isn't worth thinking about.
   */
  const WITH_COUNTS = `
    SELECT c.*,
           (SELECT COUNT(*) FROM materials m WHERE m.course_id = c.id) AS files,
           (SELECT COALESCE(SUM(m.bytes),0) FROM materials m WHERE m.course_id = c.id) AS bytes,
           (SELECT COUNT(*) FROM lectures l WHERE l.course_id = c.id) AS lectures,
           (SELECT COUNT(*) FROM lectures l JOIN transcripts t ON t.lecture_id = l.id
             WHERE l.course_id = c.id AND t.status = 'done') AS transcribed,
           (SELECT COUNT(*) FROM cards ca JOIN decks d ON d.id = ca.deck_id
             WHERE d.course_id = c.id) AS cards
      FROM courses c`;

  app.get<{ Querystring: { all?: string } }>("/api/courses", async (req) => {
    return req.query.all === "1"
      ? db.prepare(`${WITH_COUNTS} WHERE c.excluded = 0 ORDER BY c.active DESC, c.name`).all()
      : db.prepare(`${WITH_COUNTS} WHERE c.active = 1 AND c.excluded = 0 ORDER BY c.name`).all();
  });

  /** What this course wants pulled down. Separate from whether you're taking it. */
  app.put<{ Params: { id: string }; Body: { materials?: boolean; lectures?: boolean } }>(
    "/api/courses/:id/sync",
    async (req, reply) => {
      const exists = db.prepare("SELECT id FROM courses WHERE id = ?").get(req.params.id);
      if (!exists) return reply.code(404).send({ error: "Course not found." });
      if (req.body?.materials !== undefined) {
        db.prepare("UPDATE courses SET sync_materials = ? WHERE id = ?").run(
          req.body.materials ? 1 : 0,
          req.params.id,
        );
      }
      if (req.body?.lectures !== undefined) {
        db.prepare("UPDATE courses SET sync_lectures = ? WHERE id = ?").run(
          req.body.lectures ? 1 : 0,
          req.params.id,
        );
      }
      return db.prepare(`${WITH_COUNTS} WHERE c.id = ?`).get(req.params.id);
    },
  );

  /**
   * Remove a course and everything downloaded for it.
   *
   * Marked excluded rather than deleted outright, because Moodle will hand it
   * back on the next sync and an enrolment you've dismissed should stay
   * dismissed. Downloaded files are unlinked from disk — the point of removing a
   * notice board with forty PDFs in it is to get the forty PDFs back.
   */
  app.delete<{ Params: { id: string } }>("/api/courses/:id", async (req, reply) => {
    const course = db.prepare("SELECT id, code, name FROM courses WHERE id = ?").get(req.params.id) as
      | { id: string; code: string | null; name: string }
      | undefined;
    if (!course) return reply.code(404).send({ error: "Course not found." });

    const paths = (
      db
        .prepare("SELECT path FROM materials WHERE course_id = ? AND path IS NOT NULL")
        .all(course.id) as { path: string }[]
    ).map((r) => r.path);

    let filesRemoved = 0;
    for (const path of paths) {
      try {
        rmSync(path, { force: true });
        filesRemoved++;
      } catch {
        /* already gone, or not ours to remove */
      }
    }

    // Cascades handle materials, lectures, transcripts, decks and cards; events
    // and notes are set null by their own foreign keys.
    const before = db
      .prepare("SELECT (SELECT COUNT(*) FROM lectures WHERE course_id = ?) AS lectures")
      .get(course.id) as { lectures: number };
    db.prepare("DELETE FROM materials WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM lectures WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM events WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM assignments WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM course_text WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM chunks WHERE course_id = ?").run(course.id);
    db.prepare(
      "UPDATE courses SET excluded = 1, active = 0, active_override = 0 WHERE id = ?",
    ).run(course.id);

    app.log.info(`Removed course ${course.code ?? course.name}: ${filesRemoved} files unlinked`);
    return {
      ok: true,
      course: course.code ?? course.name,
      filesRemoved,
      lecturesRemoved: before.lectures,
    };
  });

  /** Put one back. Excluding something should never be a one-way door. */
  app.post<{ Params: { id: string } }>("/api/courses/:id/restore", async (req) => {
    db.prepare("UPDATE courses SET excluded = 0, active_override = NULL WHERE id = ?").run(
      req.params.id,
    );
    return { ok: true, courses: db.prepare("SELECT id, code, name FROM courses WHERE excluded = 1").all() };
  });

  /** What's been dismissed, so it can be found again. */
  app.get("/api/courses/excluded", async () =>
    db.prepare("SELECT id, code, name FROM courses WHERE excluded = 1 ORDER BY name").all(),
  );

  // Manually mark a course active/inactive (null clears the override → auto).
  app.put<{ Params: { id: string }; Body: { active: boolean | null } }>(
    "/api/courses/:id/active",
    async (req) => {
      const v = req.body.active;
      const override = v === null ? null : v ? 1 : 0;
      db.prepare("UPDATE courses SET active_override = ?, active = COALESCE(?, active) WHERE id = ?").run(
        override,
        override,
        req.params.id,
      );
      return db.prepare("SELECT * FROM courses WHERE id = ?").get(req.params.id);
    },
  );

  app.get<{ Querystring: { course_id?: string } }>("/api/assignments", async (req) => {
    const { course_id } = req.query;
    if (course_id)
      return db
        .prepare("SELECT * FROM assignments WHERE course_id = ? ORDER BY due_at IS NULL, due_at")
        .all(course_id);
    // Default: only active courses' assignments.
    return db
      .prepare(
        `SELECT a.* FROM assignments a JOIN courses c ON c.id = a.course_id
         WHERE c.active = 1 ORDER BY a.due_at IS NULL, a.due_at`,
      )
      .all();
  });

  app.get<{ Querystring: { course_id?: string } }>("/api/lectures", async (req) => {
    const { course_id } = req.query;
    const sel = `SELECT l.*, t.status AS transcript_status,
        CASE WHEN t.text IS NOT NULL AND length(t.text) > 0 THEN 1 ELSE 0 END AS has_text,
        CASE WHEN t.summary IS NOT NULL THEN 1 ELSE 0 END AS has_notes,
        t.updated_at AS transcript_at
      FROM lectures l LEFT JOIN transcripts t ON t.lecture_id = l.id`;
    if (course_id)
      return db.prepare(`${sel} WHERE l.course_id = ? ORDER BY l.recorded_at DESC`).all(course_id);
    // Default: active courses only (keeps the list to what you're currently taking).
    return db
      .prepare(`${sel} JOIN courses c ON c.id = l.course_id WHERE c.active = 1 ORDER BY l.recorded_at DESC`)
      .all();
  });

  app.get<{ Params: { id: string } }>("/api/lectures/:id", async (req, reply) => {
    const lecture = db.prepare("SELECT * FROM lectures WHERE id = ?").get(req.params.id);
    if (!lecture) return reply.code(404).send({ error: "not found" });
    const transcript = db.prepare("SELECT * FROM transcripts WHERE lecture_id = ?").get(req.params.id);
    return { lecture, transcript: transcript ?? null };
  });

  // Unified calendar feed for active courses (plus course-less events), windowed by ?from=&to=.
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/events", async (req) => {
    const { from, to } = req.query;
    const activeFilter =
      "(e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))";
    if (from && to) {
      return db
        .prepare(
          `SELECT e.* FROM events e WHERE ${activeFilter} AND e.start_at >= ? AND e.start_at <= ? ORDER BY e.start_at`,
        )
        .all(from, to);
    }
    return db.prepare(`SELECT e.* FROM events e WHERE ${activeFilter} ORDER BY e.start_at`).all();
  });
}
