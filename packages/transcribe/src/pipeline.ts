import { getDb, type Lecture } from "@uni/db";
import { resolveAudio } from "./download.js";
import { probeDuration } from "./ffmpeg.js";
import { transcribeFile } from "./openai-transcribe.js";

type Status = "pending" | "downloading" | "transcribing" | "done" | "error";

// Simple in-process sequential queue: transcription is CPU-heavy, so we run one
// lecture at a time and let the UI poll status.
const queue: string[] = [];
let running = false;

export function enqueue(lectureId: string): { queued: boolean; position: number } {
  setStatus(lectureId, "pending", { error: null });
  if (!queue.includes(lectureId)) queue.push(lectureId);
  void pump();
  return { queued: true, position: queue.indexOf(lectureId) + 1 };
}

export function queueState(): { running: string | null; pending: string[] } {
  return { running: running ? (queue[0] ?? null) : null, pending: queue.slice(running ? 1 : 0) };
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue[0]!;
      await processOne(id).catch((e) => setStatus(id, "error", { error: String(e) }));
      queue.shift();
    }
  } finally {
    running = false;
  }
}

async function processOne(lectureId: string): Promise<void> {
  const lecture = getDb()
    .prepare("SELECT * FROM lectures WHERE id = ?")
    .get(lectureId) as Lecture | undefined;
  if (!lecture) throw new Error("Lecture not found");

  setStatus(lectureId, "downloading", { error: null });
  const { audioPath } = await resolveAudio(lecture);

  const duration = await probeDuration(audioPath);
  if (duration != null) {
    getDb().prepare("UPDATE lectures SET media_path = ?, duration_sec = ? WHERE id = ?").run(audioPath, duration, lectureId);
  }

  setStatus(lectureId, "transcribing", { error: null });
  const { text, segments } = await transcribeFile(audioPath);

  setStatus(lectureId, "done", { text, segments, error: null });
}

function setStatus(
  lectureId: string,
  status: Status,
  extra: { text?: string; segments?: unknown; error?: string | null },
): void {
  const db = getDb();
  const id = "tr:" + lectureId;
  db.prepare(
    `INSERT INTO transcripts (id, lecture_id, status, text, segments, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lecture_id) DO UPDATE SET
       status = excluded.status,
       text = COALESCE(excluded.text, transcripts.text),
       segments = COALESCE(excluded.segments, transcripts.segments),
       error = excluded.error,
       updated_at = datetime('now')`,
  ).run(
    id,
    lectureId,
    status,
    extra.text ?? null,
    extra.segments ? JSON.stringify(extra.segments) : null,
    extra.error ?? null,
  );
}
