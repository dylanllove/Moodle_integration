import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getDb } from "@uni/db";

interface NoteBody {
  title?: string;
  body?: string;
  course_id?: string | null;
  lecture_id?: string | null;
}

export async function registerNotesRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get<{ Querystring: { course_id?: string; lecture_id?: string } }>(
    "/api/notes",
    async (req) => {
      const { course_id, lecture_id } = req.query;
      if (lecture_id)
        return db.prepare("SELECT * FROM notes WHERE lecture_id = ? ORDER BY updated_at DESC").all(lecture_id);
      if (course_id)
        return db.prepare("SELECT * FROM notes WHERE course_id = ? ORDER BY updated_at DESC").all(course_id);
      return db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all();
    },
  );

  app.get<{ Params: { id: string } }>("/api/notes/:id", async (req, reply) => {
    const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
    return note ?? reply.code(404).send({ error: "not found" });
  });

  app.post<{ Body: NoteBody }>("/api/notes", async (req) => {
    const id = randomUUID();
    const { title = "Untitled", body = "", course_id = null, lecture_id = null } = req.body ?? {};
    db.prepare(
      "INSERT INTO notes (id, course_id, lecture_id, title, body) VALUES (?,?,?,?,?)",
    ).run(id, course_id, lecture_id, title, body);
    return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  });

  app.put<{ Params: { id: string }; Body: NoteBody }>("/api/notes/:id", async (req, reply) => {
    const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id) as
      | { title: string; body: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "not found" });
    const title = req.body.title ?? existing.title;
    const body = req.body.body ?? existing.body;
    db.prepare("UPDATE notes SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?").run(
      title,
      body,
      req.params.id,
    );
    return db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/notes/:id", async (req) => {
    db.prepare("DELETE FROM notes WHERE id = ?").run(req.params.id);
    return { ok: true };
  });
}
