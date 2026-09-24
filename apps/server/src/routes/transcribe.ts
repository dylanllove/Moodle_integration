import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { getDb, dataDir } from "@uni/db";
import { generateLectureNotes } from "../notes-gen.js";
import { transcribeLectureNow } from "../transcripts.js";

export async function registerTranscribeRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Transcribe a lecture now. Same route as the background sync — slides are
  // read, captions are tried before audio, audio is transcribed locally when it
  // can be — it just doesn't wait for the next sync to come round.
  app.post<{ Params: { id: string } }>("/api/lectures/:id/transcribe", async (req, reply) => {
    const lecture = db.prepare("SELECT id FROM lectures WHERE id = ?").get(req.params.id);
    if (!lecture) return reply.code(404).send({ error: "lecture not found" });

    const existing = db
      .prepare("SELECT status FROM transcripts WHERE lecture_id = ?")
      .get(req.params.id) as { status: string } | undefined;
    if (existing?.status === "done") return { ok: true, alreadyDone: true };

    return { ok: true, ...transcribeLectureNow(app, req.params.id) };
  });

  // Upload a recording (mp3/mp4/m4a/wav) → a new lecture, transcribed in the background.
  app.post("/api/lectures/upload", async (req, reply) => {
    const mp = await (req as any).file();
    if (!mp) return reply.code(400).send({ error: "no file uploaded" });
    const courseId = (mp.fields?.course_id?.value as string) || null;
    const title = (mp.fields?.title?.value as string) || mp.filename || "Uploaded recording";

    const dir = join(dataDir(), "uploads");
    mkdirSync(dir, { recursive: true });
    const raw = join(dir, `${randomUUID()}-${mp.filename}`);
    writeFileSync(raw, await mp.toBuffer());

    const lectureId = "upload:" + randomUUID();
    db.prepare(
      `INSERT INTO lectures (id, course_id, title, provider, media_path) VALUES (?,?,?,?,?)`,
    ).run(lectureId, courseId, title, "upload", raw);

    transcribeLectureNow(app, lectureId);
    return { ok: true, lecture_id: lectureId };
  });

  // (Re)generate the study notes for a lecture that already has a transcript.
  app.post<{ Params: { id: string } }>("/api/lectures/:id/notes", async (req, reply) => {
    const t = db
      .prepare("SELECT status FROM transcripts WHERE lecture_id = ?")
      .get(req.params.id) as { status: string } | undefined;
    if (t?.status !== "done") return reply.code(400).send({ error: "no transcript to summarise yet" });
    await generateLectureNotes(req.params.id, { force: true });
    const row = db.prepare("SELECT summary FROM transcripts WHERE lecture_id = ?").get(req.params.id);
    return { ok: true, ...(row as object) };
  });
}
