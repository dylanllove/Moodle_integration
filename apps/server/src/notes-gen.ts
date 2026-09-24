import { randomUUID } from "node:crypto";
import { getDb, getSetting, type TranscriptSegment } from "@uni/db";
import {
  analyseLecture,
  canComplete,
  renderNotesMarkdown,
  ANALYSIS_VERSION,
  type AnalysisResult,
} from "@uni/ai";
import { createDeck } from "./decks.js";

/**
 * Turn a finished transcript into study material: an overview, sections,
 * concepts, the lecturer's exam hints and flashcard questions — as rows, each
 * pointing at the second (or slide) it came from.
 *
 * One model call does all of it. The markdown notes the app has always shown are
 * rendered from those rows rather than written separately, and the lecture's deck
 * is built from the questions, so there's no second pass over the lecture just to
 * make cards.
 */
export async function generateLectureNotes(
  lectureId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!(await canComplete())) return;
  const db = getDb();
  const t = db
    .prepare("SELECT text, segments FROM transcripts WHERE lecture_id = ?")
    .get(lectureId) as { text: string | null; segments: string | null } | undefined;
  if (!t?.text || t.text.length < 200) return;
  const lec = db
    .prepare(
      `SELECT l.title, l.course_id, l.recorded_at, c.name AS course_name, c.start_date
         FROM lectures l LEFT JOIN courses c ON c.id = l.course_id WHERE l.id = ?`,
    )
    .get(lectureId) as
    | {
        title: string;
        course_id: string | null;
        recorded_at: string | null;
        course_name: string | null;
        start_date: string | null;
      }
    | undefined;

  const result = await analyseLecture({
    text: t.text,
    segments: parseSegments(t.segments),
    title: lec?.title,
    courseName: lec?.course_name ?? undefined,
  });

  // The same transcript analysed by the same version is the same answer; don't
  // churn row ids (and the cards linked to them) for nothing.
  const existing = db
    .prepare("SELECT input_hash, schema_version FROM lecture_digests WHERE lecture_id = ?")
    .get(lectureId) as { input_hash: string; schema_version: number } | undefined;
  const unchanged =
    existing?.input_hash === result.inputHash && existing.schema_version === ANALYSIS_VERSION;
  if (!unchanged || opts.force) {
    storeAnalysis(lectureId, result, teachingWeek(lec?.recorded_at ?? null, lec?.start_date ?? null));
  }

  await autoDeck(lectureId, lec?.title ?? "Lecture", lec?.course_id ?? null);
}

function parseSegments(raw: string | null): TranscriptSegment[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as TranscriptSegment[]) : null;
  } catch {
    return null;
  }
}

/** Week of term, counting the course's first week as 1. */
function teachingWeek(recordedAt: string | null, courseStart: string | null): number | null {
  if (!recordedAt || !courseStart) return null;
  const days = (Date.parse(recordedAt) - Date.parse(courseStart)) / 864e5;
  if (!Number.isFinite(days) || days < -7) return null;
  const week = Math.floor(days / 7) + 1;
  return week >= 1 && week <= 30 ? week : null;
}

/** Replace a lecture's structured rows in one transaction, then re-render its notes. */
function storeAnalysis(lectureId: string, r: AnalysisResult, week: number | null): void {
  const db = getDb();
  const a = r.analysis;
  db.exec("BEGIN");
  try {
    for (const table of ["lecture_questions", "lecture_emphasis", "lecture_concepts", "lecture_sections"]) {
      db.prepare(`DELETE FROM ${table} WHERE lecture_id = ?`).run(lectureId);
    }
    db.prepare(
      `INSERT INTO lecture_digests (lecture_id, tldr, topics, week, anchor, schema_version, model, input_hash, generated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(lecture_id) DO UPDATE SET tldr=excluded.tldr, topics=excluded.topics, week=excluded.week,
         anchor=excluded.anchor, schema_version=excluded.schema_version, model=excluded.model,
         input_hash=excluded.input_hash, generated_at=excluded.generated_at`,
    ).run(lectureId, a.tldr, JSON.stringify(a.topics), week, r.anchor, ANALYSIS_VERSION, r.model, r.inputHash);

    const sectionIds = a.sections.map(() => randomUUID());
    const insSection = db.prepare(
      "INSERT INTO lecture_sections (id, lecture_id, idx, title, summary, start_sec, end_sec) VALUES (?,?,?,?,?,?,?)",
    );
    a.sections.forEach((s, i) =>
      insSection.run(sectionIds[i]!, lectureId, i, s.title, s.summary, s.start, s.end),
    );

    const conceptIds = new Map<string, string>();
    const insConcept = db.prepare(
      "INSERT INTO lecture_concepts (id, lecture_id, section_id, kind, name, explanation, start_sec) VALUES (?,?,?,?,?,?,?)",
    );
    for (const c of a.concepts) {
      const id = randomUUID();
      conceptIds.set(c.name.toLowerCase(), id);
      insConcept.run(id, lectureId, sectionIds[c.section] ?? null, c.kind, c.name, c.explanation, c.start);
    }

    const insEmphasis = db.prepare(
      "INSERT INTO lecture_emphasis (id, lecture_id, quote, why, start_sec) VALUES (?,?,?,?,?)",
    );
    for (const e of a.emphasis) insEmphasis.run(randomUUID(), lectureId, e.quote, e.why, e.start);

    const insQuestion = db.prepare(
      "INSERT INTO lecture_questions (id, lecture_id, concept_id, question, answer, start_sec) VALUES (?,?,?,?,?,?)",
    );
    for (const q of a.questions) {
      insQuestion.run(randomUUID(), lectureId, conceptIds.get(q.concept.toLowerCase()) ?? null, q.q, q.a, q.start);
    }

    db.prepare("UPDATE transcripts SET summary = ? WHERE lecture_id = ?").run(
      renderNotesMarkdown(a, r.anchor),
      lectureId,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * One deck per lecture, made once, from the questions the analysis already wrote.
 * Never regenerates over an existing deck — those cards carry review history.
 */
export async function autoDeck(lectureId: string, title: string, courseId: string | null): Promise<void> {
  if (getSetting("auto_flashcards") === "false") return;
  const db = getDb();
  const existing = db.prepare("SELECT id FROM decks WHERE lecture_id = ? LIMIT 1").get(lectureId) as
    | { id: string }
    | undefined;
  if (existing) return;
  const cards = db
    .prepare("SELECT question AS q, answer AS a FROM lecture_questions WHERE lecture_id = ? ORDER BY start_sec")
    .all(lectureId) as { q: string; a: string }[];
  if (cards.length < 3) return;
  createDeck({ course_id: courseId, lecture_id: lectureId, title, source: "lecture", source_ref: lectureId, cards });
}
