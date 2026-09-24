import { getDb, type TranscriptSegment } from "@uni/db";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Where a chunk came from. Drives how a citation is resolved and linked. */
export type ChunkSource = "note" | "transcript" | "material" | "course_text" | "digest";

export interface RetrievedChunk {
  text: string;
  sourceType: ChunkSource;
  sourceId: string;
  courseId: string | null;
  /** The lecture it belongs to, for transcript and digest chunks. */
  lectureId: string | null;
  /** Seconds into the recording (or the slide number, for a deck), when known. */
  startSec: number | null;
  score: number;
}

interface Piece {
  text: string;
  start: number | null;
  end: number | null;
}

interface IndexSource {
  type: ChunkSource;
  id: string;
  courseId: string | null;
  lectureId: string | null;
  pieces: () => Piece[];
  /** Identifies the content; unchanged content is not re-chunked. */
  hash: string;
}

/**
 * Bring the chunk index up to date with the student's notes, transcripts,
 * structured lecture digests, course prose and files. Retrieval is lexical (TF
 * over tokens) — no embedding model to download, works fully offline. Grounding
 * the assistant in the student's OWN material keeps it an aid rather than a
 * ghostwriter.
 *
 * Incremental: a source whose content hasn't changed keeps its chunks, so a
 * sync that brings one new lecture re-chunks one lecture, not the semester.
 */
export function indexAll(): { chunks: number; changed: number } {
  const db = getDb();
  const sources: IndexSource[] = [];
  const add = (
    type: ChunkSource,
    id: string,
    courseId: string | null,
    lectureId: string | null,
    content: string,
    pieces: () => Piece[],
  ) => sources.push({ type, id, courseId, lectureId, pieces, hash: sha(content) });
  const plain = (text: string) => () => splitChunks(text).map((t) => ({ text: t, start: null, end: null }));

  const notes = db
    .prepare("SELECT id, course_id, title, body FROM notes")
    .all() as { id: string; course_id: string | null; title: string; body: string }[];
  for (const n of notes) {
    const text = `${n.title}\n${n.body}`;
    add("note", n.id, n.course_id, null, text, plain(text));
  }

  // Transcripts chunk along their segments, so each chunk knows when it was said.
  const transcripts = db
    .prepare(
      `SELECT t.lecture_id AS id, l.course_id AS course_id, t.text AS text, t.segments AS segments
         FROM transcripts t JOIN lectures l ON l.id = t.lecture_id WHERE t.text IS NOT NULL`,
    )
    .all() as { id: string; course_id: string | null; text: string; segments: string | null }[];
  for (const t of transcripts) {
    add("transcript", t.id, t.course_id, t.id, `${t.text}\n${t.segments ?? ""}`, () => {
      const segs = parseSegments(t.segments);
      return segs.length ? chunkSegments(segs) : plain(t.text)();
    });
  }

  // The structured digest: the overview, then one chunk per section with the
  // concepts taught in it — the densest, best-labelled text there is about a
  // lecture, and each piece carries the moment its section starts.
  const digests = db
    .prepare(
      `SELECT d.lecture_id AS id, l.course_id, l.title, d.tldr, d.topics, d.input_hash, d.anchor
         FROM lecture_digests d JOIN lectures l ON l.id = d.lecture_id`,
    )
    .all() as {
    id: string;
    course_id: string | null;
    title: string;
    tldr: string;
    topics: string;
    input_hash: string;
    anchor: string;
  }[];
  const sectionsOf = db.prepare(
    "SELECT id, title, summary, start_sec, end_sec FROM lecture_sections WHERE lecture_id = ? ORDER BY idx",
  );
  const conceptsOf = db.prepare(
    "SELECT section_id, name, explanation FROM lecture_concepts WHERE lecture_id = ?",
  );
  for (const d of digests) {
    add("digest", d.id, d.course_id, d.id, `${d.input_hash}\n${d.tldr}`, () => {
      const sections = sectionsOf.all(d.id) as {
        id: string;
        title: string;
        summary: string;
        start_sec: number | null;
        end_sec: number | null;
      }[];
      const concepts = conceptsOf.all(d.id) as { section_id: string | null; name: string; explanation: string }[];
      const line = (c: { name: string; explanation: string }) => `${c.name}: ${c.explanation}`;
      const pieces: Piece[] = [
        {
          text: `${d.title}\n${d.tldr}\nTopics: ${safeList(d.topics).join(", ")}\n${concepts
            .filter((c) => !c.section_id)
            .map(line)
            .join("\n")}`.trim(),
          start: null,
          end: null,
        },
      ];
      for (const s of sections) {
        const inSection = concepts.filter((c) => c.section_id === s.id).map(line);
        pieces.push({
          text: `${d.title} — ${s.title}\n${s.summary}${inSection.length ? `\n${inSection.join("\n")}` : ""}`,
          start: s.start_sec,
          end: s.end_sec,
        });
      }
      return pieces;
    });
  }

  // Course prose (forum posts, labels, section summaries) — logistics + content.
  const texts = db
    .prepare("SELECT id, course_id, title, body FROM course_text")
    .all() as { id: string; course_id: string | null; title: string | null; body: string }[];
  for (const x of texts) {
    const text = `${x.title ?? ""}\n${x.body}`;
    add("course_text", x.id, x.course_id, null, text, plain(text));
  }

  // Slides, readings and handouts. The material sync has already extracted the
  // text of every file it downloaded; without this the assistant can't see the
  // half of the course that is never said out loud.
  const materials = db
    .prepare(
      "SELECT id, course_id, title, text FROM materials WHERE text IS NOT NULL AND length(text) > 200",
    )
    .all() as { id: string; course_id: string | null; title: string; text: string }[];
  for (const m of materials) {
    const text = `${m.title}\n${m.text}`;
    add("material", m.id, m.course_id, null, text, plain(text));
  }

  // What the index holds now, per source, by content hash.
  const have = new Map<string, string | null>();
  for (const r of db
    .prepare("SELECT source_type, source_id, MAX(source_hash) AS h FROM chunks GROUP BY 1, 2")
    .all() as { source_type: string; source_id: string; h: string | null }[]) {
    have.set(`${r.source_type}\u0000${r.source_id}`, r.h);
  }

  const del = db.prepare("DELETE FROM chunks WHERE source_type = ? AND source_id = ?");
  const insert = db.prepare(
    `INSERT INTO chunks (id, source_type, source_id, course_id, lecture_id, start_sec, end_sec, source_hash, text)
     VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  );
  let changed = 0;
  db.exec("BEGIN");
  try {
    for (const src of sources) {
      const key = `${src.type}\u0000${src.id}`;
      const current = have.get(key);
      have.delete(key);
      if (current === src.hash) continue;
      // Too short to chunk has no rows to compare against, so it arrives here
      // every run; only count it when rows actually move.
      let moved = Number(del.run(src.type, src.id).changes);
      for (const p of src.pieces()) {
        if (p.text.length <= 30) continue;
        moved += 1;
        insert.run(
          `${src.type}:${src.id}:${sha(`${p.start ?? ""}|${p.text}`)}`,
          src.type,
          src.id,
          src.courseId,
          src.lectureId,
          p.start,
          p.end,
          src.hash,
          p.text,
        );
      }
      if (moved) changed++;
    }
    // Whatever is left was deleted upstream.
    for (const key of have.keys()) {
      const [type, id] = key.split("\u0000");
      del.run(type!, id!);
      changed++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const n = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
  if (changed) invalidateCache();
  return { chunks: n, changed };
}

function parseSegments(raw: string | null): TranscriptSegment[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => s && typeof s.text === "string") : [];
  } catch {
    return [];
  }
}

function safeList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * ~800-char chunks built from whole segments. A slide deck's segments are pages
 * and stay one-per-chunk-boundary, so a hit can say which slide.
 */
function chunkSegments(segs: TranscriptSegment[], size = 800): Piece[] {
  const out: Piece[] = [];
  let cur: Piece | null = null;
  for (const s of segs) {
    const t = s.text.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const at = s.page ?? s.start;
    const end = s.page ?? s.end;
    const newPage = s.page != null && cur && cur.start !== s.page;
    if (!cur || cur.text.length + t.length > size || newPage) {
      if (cur) out.push(cur);
      cur = { text: t, start: at, end };
    } else {
      cur.text += " " + t;
      cur.end = end;
    }
  }
  if (cur) out.push(cur);
  // A single slide longer than a chunk is still worth splitting.
  return out.flatMap((p) =>
    p.text.length > size * 1.5 ? splitChunks(p.text, size).map((t) => ({ ...p, text: t })) : [p],
  );
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
  lectureId: string | null;
  startSec: number | null;
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
  // indexAll() drops the cache whenever it changes anything; the count check
  // catches a rebuild from another process.
  if (cache && cache.count === count) return cache.rows;

  const raw = db
    .prepare("SELECT source_type, source_id, course_id, lecture_id, start_sec, text FROM chunks")
    .all() as {
    source_type: string;
    source_id: string;
    course_id: string | null;
    lecture_id: string | null;
    start_sec: number | null;
    text: string;
  }[];
  const rows = raw.map((r) => {
    const tokens = tokenize(r.text);
    return {
      text: r.text,
      sourceType: r.source_type as ChunkSource,
      sourceId: r.source_id,
      courseId: r.course_id,
      lectureId: r.lecture_id,
      startSec: r.start_sec,
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
      lectureId: r.lectureId,
      startSec: r.startSec,
      score: hits * r.norm,
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
