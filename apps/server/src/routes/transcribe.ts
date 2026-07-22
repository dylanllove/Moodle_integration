import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { enqueue, queueState, extractAudioMp3, transcribeFile } from "@uni/transcribe";
import { getDb, dataDir } from "@uni/db";
import { extractSlideText } from "../extract.js";

export async function registerTranscribeRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Process a lecture into a transcript. Slide decks → extract text; audio/video
  // recordings → enqueue for OpenAI transcription.
  app.post<{ Params: { id: string } }>("/api/lectures/:id/transcribe", async (req, reply) => {
    const lecture = db.prepare("SELECT * FROM lectures WHERE id = ?").get(req.params.id) as
      | { id: string; provider: string | null; media_url: string | null }
      | undefined;
    if (!lecture) return reply.code(404).send({ error: "lecture not found" });

    const existing = db
      .prepare("SELECT status FROM transcripts WHERE lecture_id = ?")
      .get(req.params.id) as { status: string } | undefined;
    if (existing?.status === "done") return { ok: true, alreadyDone: true };

    const isSlides =
      lecture.provider === "slides" || /\.(pdf|pptx?)($|\?)/i.test(lecture.media_url ?? "");
    if (isSlides && lecture.media_url) {
      setStatus(db, lecture.id, "transcribing");
      try {
        const text = await extractSlideText(lecture.media_url);
        setDone(db, lecture.id, text || "(no extractable text in this file)");
        return { ok: true, mode: "slides" };
      } catch (e) {
        setError(db, lecture.id, String(e));
        return reply.code(500).send({ error: String(e) });
      }
    }

    return { ok: true, mode: "audio", ...enqueue(req.params.id) };
  });

  // Upload a recording (mp3/mp4/m4a/wav) → new lecture + OpenAI transcript.
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

    setStatus(db, lectureId, "transcribing");
    try {
      const mp3 = raw.replace(/\.[^.]+$/, "") + ".mp3";
      await extractAudioMp3(raw, mp3);
      const { text, segments } = await transcribeFile(mp3);
      db.prepare(
        `INSERT INTO transcripts (id, lecture_id, status, text, segments) VALUES (?,?,?,?,?)
         ON CONFLICT(lecture_id) DO UPDATE SET status='done', text=excluded.text, segments=excluded.segments, updated_at=datetime('now')`,
      ).run("tr:" + lectureId, lectureId, "done", text, JSON.stringify(segments));
      return { ok: true, lecture_id: lectureId };
    } catch (e) {
      setError(db, lectureId, String(e));
      return reply.code(500).send({ error: String(e) });
    }
  });

  app.get("/api/transcribe/status", async () => {
    const rows = db.prepare("SELECT lecture_id, status, error FROM transcripts").all();
    return { queue: queueState(), lectures: rows };
  });
}

function setStatus(db: ReturnType<typeof getDb>, lectureId: string, status: string): void {
  db.prepare(
    `INSERT INTO transcripts (id, lecture_id, status) VALUES (?,?,?)
     ON CONFLICT(lecture_id) DO UPDATE SET status=excluded.status, error=NULL, updated_at=datetime('now')`,
  ).run("tr:" + lectureId, lectureId, status);
}
function setDone(db: ReturnType<typeof getDb>, lectureId: string, text: string): void {
  db.prepare(
    `UPDATE transcripts SET status='done', text=?, error=NULL, updated_at=datetime('now') WHERE lecture_id=?`,
  ).run(text, lectureId);
}
function setError(db: ReturnType<typeof getDb>, lectureId: string, err: string): void {
  db.prepare(
    `UPDATE transcripts SET status='error', error=?, updated_at=datetime('now') WHERE lecture_id=?`,
  ).run(err, lectureId);
}
