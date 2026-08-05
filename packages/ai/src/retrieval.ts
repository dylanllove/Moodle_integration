import { getDb } from "@uni/db";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Where a chunk came from. Drives how a citation is resolved and linked. */
export type ChunkSource = "note" | "transcript" | "material";

export interface RetrievedChunk {
  text: string;
  sourceType: ChunkSource;
  sourceId: string;
  courseId: string | null;
  score: number;
}

/**
 * (Re)build the chunk index from the student's own notes, transcripts and
 * course files. Retrieval is lexical (TF over tokens) — no embedding model to
 * download, works fully offline. Grounding the assistant in the student's OWN
 * material keeps it an aid rather than a ghostwriter.
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

  // Course prose (forum posts, labels, section summaries) — logistics + content.
  const texts = db
    .prepare("SELECT id, course_id, title, body FROM course_text")
    .all() as { id: string; course_id: string | null; title: string | null; body: string }[];
  for (const x of texts) addChunks("transcript", x.id, x.course_id, `${x.title ?? ""}\n${x.body}`);

  // Slides, readings and handouts. The material sync has already extracted the
  // text of every file it downloaded; without this the assistant can't see the
  // half of the course that is never said out loud.
  const materials = db
    .prepare(
      "SELECT id, course_id, title, text FROM materials WHERE text IS NOT NULL AND length(text) > 200",
    )
    .all() as { id: string; course_id: string | null; title: string; text: string }[];
  for (const m of materials) addChunks("material", m.id, m.course_id, `${m.title}\n${m.text}`);

  const n = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
  invalidateCache();
  return { chunks: n };
}

function addChunks(
  sourceType: ChunkSource,
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

/**
 * Tokenising every chunk on every query was fine at a few hundred chunks, but
 * course files multiply the index several-fold and search-as-you-type asks for
 * it on each keystroke. Tokens are cached and rebuilt whenever the index
 * changes — cheap, and invisible from the outside.
 */
interface CachedChunk {
  text: string;
  sourceType: ChunkSource;
  sourceId: string;
  courseId: string | null;
  tokens: string[];
  /** Precomputed 1/sqrt(len+1) — the length normaliser in the score. */
  norm: number;
}
let cache: { rows: CachedChunk[]; count: number } | null = null;

function invalidateCache(): void {
  cache = null;
}

function allChunks(): CachedChunk[] {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
  // A changed row count is the only way this index ever moves — indexAll()
  // clears and rewrites it wholesale.
  if (cache && cache.count === count) return cache.rows;

  const raw = db.prepare("SELECT source_type, source_id, course_id, text FROM chunks").all() as {
    source_type: string;
    source_id: string;
    course_id: string | null;
    text: string;
  }[];
  const rows = raw.map((r) => {
    const tokens = tokenize(r.text);
    return {
      text: r.text,
      sourceType: r.source_type as ChunkSource,
      sourceId: r.source_id,
      courseId: r.course_id,
      tokens,
      norm: 1 / Math.sqrt(tokens.length + 1),
    };
  });
  cache = { rows, count };
  return rows;
}

/** Return the top-k chunks most relevant to the query (optionally per-course). */
export function retrieve(query: string, courseId?: string | null, k = 6): RetrievedChunk[] {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  const rows = courseId ? allChunks().filter((r) => r.courseId === courseId) : allChunks();

  const scored: RetrievedChunk[] = [];
  for (const r of rows) {
    let hits = 0;
    for (const t of r.tokens) if (qTokens.has(t)) hits++;
    if (hits === 0) continue;
    scored.push({
      text: r.text,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      courseId: r.courseId,
      score: hits * r.norm,
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
