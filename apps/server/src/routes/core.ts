import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";

/** Read endpoints for courses, assignments, lectures, notes and events. */
export async function registerCoreRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Courses. ?all=1 returns every course; default returns active only.
  app.get<{ Querystring: { all?: string } }>("/api/courses", async (req) => {
    return req.query.all === "1"
      ? db.prepare("SELECT * FROM courses ORDER BY active DESC, name").all()
      : db.prepare("SELECT * FROM courses WHERE active = 1 ORDER BY name").all();
  });

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
