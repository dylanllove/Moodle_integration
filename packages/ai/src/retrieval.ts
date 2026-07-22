import { getDb } from "@uni/db";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export interface RetrievedChunk {
  text: string;
  sourceType: "note" | "transcript";
  sourceId: string;
  courseId: string | null;
  score: number;
}

/**
 * (Re)build the chunk index from the student's own notes and transcripts.
 * Retrieval is lexical (TF over tokens) — no embedding model to download, works
 * fully offline. Grounding the assistant in the student's OWN material keeps it
 * an aid rather than a ghostwriter.
 */
export function indexAll(): { chunks: number } {
  const db = getDb();
  db.prepare("DELETE FROM chunks").run();

  const notes = db
    .prepare("SELECT id, course_id, title, body FROM notes")
    .all() as { id: string; course_id: string | null; title: string; body: string }[];
  for (const n of notes) addChunks("note", n.id, n.course_id, `${n.title}\n${n.body}`);

  const transcripts = db
    .prepare(
      "SELECT t.lecture_id AS id, l.course_id AS course_id, t.text AS text FROM transcripts t JOIN lectures l ON l.id = t.lecture_id WHERE t.text IS NOT NULL",
    )
    .all() as { id: string; course_id: string | null; text: string }[];
  for (const t of transcripts) addChunks("transcript", t.id, t.course_id, t.text);

  const n = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
  return { chunks: n };
}

function addChunks(
  sourceType: "note" | "transcript",
  sourceId: string,
  courseId: string | null,
  text: string,
): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO chunks (id, source_type, source_id, course_id, text) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  );
  for (const chunk of splitChunks(text)) {
    const id = `${sourceType}:${sourceId}:${sha(chunk)}`;
    insert.run(id, sourceType, sourceId, courseId, chunk);
  }
}

/** ~800-char chunks on paragraph/sentence boundaries. */
function splitChunks(text: string, size = 800): string[] {
  const parts = text.split(/\n{2,}|\.(?=\s)/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + p).length > size && buf) {
      chunks.push(buf.trim());
      buf = "";
    }
    buf += p + " ";
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length > 30);
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

/** Return the top-k chunks most relevant to the query (optionally per-course). */
export function retrieve(query: string, courseId?: string | null, k = 6): RetrievedChunk[] {
  const db = getDb();
  const rows = (
    courseId
      ? db.prepare("SELECT * FROM chunks WHERE course_id = ?").all(courseId)
      : db.prepare("SELECT * FROM chunks").all()
  ) as { text: string; source_type: string; source_id: string; course_id: string | null }[];

  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  const scored = rows.map((r) => {
    const tokens = tokenize(r.text);
    let hits = 0;
    for (const t of tokens) if (qTokens.has(t)) hits++;
    const score = hits / Math.sqrt(tokens.length + 1);
    return {
      text: r.text,
      sourceType: r.source_type as "note" | "transcript",
      sourceId: r.source_id,
      courseId: r.course_id,
      score,
    };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
