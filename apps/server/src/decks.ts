import { randomUUID } from "node:crypto";
import { getDb } from "@uni/db";
import { generateDeck, hasApiKey } from "@uni/ai";
import { availability, intakeFor, markIntroduced } from "./card-schedule.js";

/**
 * Flashcard decks and their review schedule.
 *
 * Scheduling is Leitner boxes rather than full SM-2: intervals double per box,
 * a miss drops you two boxes. It's ~20 lines, it's predictable, and for one
 * semester of material it performs indistinguishably from the fancy version.
 */
const INTERVALS_DAYS = [0, 1, 3, 7, 16, 35];
const MAX_BOX = INTERVALS_DAYS.length - 1;

export type DeckSummary = {
  id: string;
  course_id: string | null;
  lecture_id: string | null;
  title: string;
  source: string;
  created_at: string;
  cards: number;
  due: number;
  /** Cards that have reached the last box — "known", loosely. */
  mastered: number;
  /** Never shown yet. These arrive at the daily rate rather than all at once. */
  unseen: number;
}

export function listDecks(courseId?: string): DeckSummary[] {
  const db = getDb();
  const now = new Date().toISOString();
  const where = courseId ? "WHERE d.course_id = ?" : "";
  const rows = db
    .prepare(
      `SELECT d.id, d.course_id, d.lecture_id, d.title, d.source, d.created_at,
              COUNT(c.id) AS cards,
              SUM(CASE WHEN c.introduced_at IS NOT NULL
                        AND (c.due_at IS NULL OR c.due_at <= ?) THEN 1 ELSE 0 END) AS review_due,
              SUM(CASE WHEN c.introduced_at IS NULL THEN 1 ELSE 0 END) AS unseen,
              SUM(CASE WHEN c.box >= ${MAX_BOX} THEN 1 ELSE 0 END) AS mastered
       FROM decks d LEFT JOIN cards c ON c.deck_id = d.id
       ${where}
       GROUP BY d.id ORDER BY d.created_at DESC`,
    )
    .all(...(courseId ? [now, courseId] : [now])) as unknown as (DeckSummary & {
    review_due: number | null;
  })[];

  // The daily allowance for new cards belongs to the *course*, so it has to be
  // shared out across that course's decks rather than granted to each of them.
  // Handing every deck the full allowance was how "all 438 due" survived the
  // introduction of a schedule at all.
  const budgets = new Map<string, number>();
  const budgetFor = (id: string | null): number => {
    const key = id ?? "__none__";
    if (!budgets.has(key)) budgets.set(key, intakeFor(id).remaining);
    return budgets.get(key)!;
  };

  // Oldest deck first, so material is met in the order it was taught.
  const order = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const allocated = new Map<string, number>();
  for (const deck of order) {
    const key = deck.course_id ?? "__none__";
    const left = budgetFor(deck.course_id);
    const take = Math.min(left, deck.unseen ?? 0);
    allocated.set(deck.id, take);
    budgets.set(key, left - take);
  }

  return rows.map((r) => ({
    id: r.id,
    course_id: r.course_id,
    lecture_id: r.lecture_id,
    title: r.title,
    source: r.source,
    created_at: r.created_at,
    cards: r.cards ?? 0,
    // What you can actually do today, not the size of the backlog.
    due: (r.review_due ?? 0) + (allocated.get(r.id) ?? 0),
    mastered: r.mastered ?? 0,
    unseen: r.unseen ?? 0,
  }));
}

/**
 * The day's queue: everything due for review, then new cards up to the day's
 * allowance.
 *
 * Reviews come first deliberately. Meeting a card once and never again is how you
 * end up with a large library and nothing retained, so re-seeing what's already
 * been started beats starting more of it.
 */
export function dueCards(opts: { deck_id?: string; course_id?: string; limit?: number } = {}) {
  const db = getDb();
  const limit = Math.min(200, opts.limit ?? 40);
  const now = new Date().toISOString();

  const scope: string[] = [];
  const scopeArgs: string[] = [];
  if (opts.deck_id) {
    scope.push("c.deck_id = ?");
    scopeArgs.push(opts.deck_id);
  }
  if (opts.course_id) {
    scope.push("d.course_id = ?");
    scopeArgs.push(opts.course_id);
  }
  const where = scope.length ? `AND ${scope.join(" AND ")}` : "";

  const SELECT = `SELECT c.id, c.deck_id, c.q, c.a, c.box, c.due_at, c.reviews, c.lapses,
              d.title AS deck_title, d.course_id
       FROM cards c JOIN decks d ON d.id = c.deck_id`;

  const reviews = db
    .prepare(
      `${SELECT}
        WHERE c.introduced_at IS NOT NULL AND (c.due_at IS NULL OR c.due_at <= ?) ${where}
        ORDER BY c.due_at IS NULL DESC, c.due_at, c.box
        LIMIT ?`,
    )
    .all(now, ...scopeArgs, limit) as unknown as ReviewRow[];

  if (reviews.length >= limit) return reviews;

  // Fill the rest with new material, but never more than today's allowance.
  const courseId =
    opts.course_id ??
    (opts.deck_id
      ? ((db.prepare("SELECT course_id FROM decks WHERE id = ?").get(opts.deck_id) as
          | { course_id: string | null }
          | undefined)?.course_id ?? null)
      : null);
  const room = Math.min(limit - reviews.length, intakeFor(courseId).remaining);
  if (room <= 0) return reviews;

  const fresh = db
    .prepare(
      `${SELECT}
        WHERE c.introduced_at IS NULL ${where}
        ORDER BY d.created_at, c.rowid
        LIMIT ?`,
    )
    .all(...scopeArgs, room) as unknown as ReviewRow[];

  return [...reviews, ...fresh];
}

interface ReviewRow {
  id: string;
  deck_id: string;
  q: string;
  a: string;
  box: number;
  due_at: string | null;
  reviews: number;
  lapses: number;
  deck_title: string;
  course_id: string | null;
}

/** Record a review. `got` false drops the card back for another pass soon. */
export function reviewCard(id: string, got: boolean): { box: number; due_at: string } | null {
  const db = getDb();
  const card = db.prepare("SELECT box, lapses FROM cards WHERE id = ?").get(id) as
    | { box: number; lapses: number }
    | undefined;
  if (!card) return null;

  const box = got ? Math.min(MAX_BOX, card.box + 1) : Math.max(0, card.box - 2);
  const days = INTERVALS_DAYS[box]!;
  // A missed card comes back in ~10 minutes, not tomorrow — that's the point of
  // the session. Box 0 on a correct answer still means "again today".
  const dueMs = got ? days * 864e5 || 6 * 3_600_000 : 10 * 60_000;
  const due = new Date(Date.now() + dueMs).toISOString();

  markIntroduced(id);
  db.prepare(
    `UPDATE cards SET box = ?, due_at = ?, reviews = reviews + 1, lapses = lapses + ?
     WHERE id = ?`,
  ).run(box, due, got ? 0 : 1, id);
  return { box, due_at: due };
}

export interface CreateDeckInput {
  course_id?: string | null;
  lecture_id?: string | null;
  title: string;
  source: string;
  source_ref?: string | null;
  cards: { q: string; a: string }[];
}

export function createDeck(input: CreateDeckInput): { id: string; cards: number } {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO decks (id, course_id, lecture_id, title, source, source_ref) VALUES (?,?,?,?,?,?)",
  ).run(
    id,
    input.course_id ?? null,
    input.lecture_id ?? null,
    input.title,
    input.source,
    input.source_ref ?? null,
  );
  const insert = db.prepare("INSERT INTO cards (id, deck_id, q, a) VALUES (?,?,?,?)");
  let n = 0;
  for (const c of input.cards) {
    if (!c.q?.trim() || !c.a?.trim()) continue;
    insert.run(randomUUID(), id, c.q.trim(), c.a.trim());
    n++;
  }
  return { id, cards: n };
}

export type DeckSource =
  | { type: "lecture"; id: string }
  | { type: "material"; id: string }
  | { type: "note"; id: string }
  | { type: "course"; id: string };

/**
 * Build a deck from something already in the library. Returns null when there's
 * nothing substantial to work from — better than a deck of three vague cards.
 */
export async function generateFrom(
  src: DeckSource,
  opts: { count?: number } = {},
): Promise<{ id: string; cards: number; title: string } | null> {
  if (!hasApiKey()) throw new Error("OPENAI_API_KEY is not set — add it in Settings.");
  const db = getDb();
  const material = gatherText(src);
  if (!material || material.text.length < 400) return null;

  const courseName = material.course_id
    ? ((db.prepare("SELECT name FROM courses WHERE id = ?").get(material.course_id) as
        | { name: string }
        | undefined)?.name ?? undefined)
    : undefined;

  const cards = await generateDeck(material.text, {
    title: material.title,
    courseName,
    count: opts.count ?? (src.type === "course" ? 40 : 20),
  });
  if (!cards.length) return null;

  const created = createDeck({
    course_id: material.course_id,
    lecture_id: src.type === "lecture" ? src.id : null,
    title: material.title,
    source: src.type,
    source_ref: src.id,
    cards,
  });
  return { ...created, title: material.title };
}

/** Pull the best available text for a source, plus a human title. */
function gatherText(
  src: DeckSource,
): { text: string; title: string; course_id: string | null } | null {
  const db = getDb();

  if (src.type === "lecture") {
    const row = db
      .prepare(
        `SELECT l.title, l.course_id, t.summary, t.text FROM lectures l
         LEFT JOIN transcripts t ON t.lecture_id = l.id WHERE l.id = ?`,
      )
      .get(src.id) as
      | { title: string; course_id: string | null; summary: string | null; text: string | null }
      | undefined;
    if (!row) return null;
    // Prefer the generated notes: they're already distilled, so the cards
    // inherit that structure instead of re-deriving it from raw speech.
    const text = (row.summary?.length ?? 0) > 600 ? row.summary! : (row.text ?? "");
    return { text, title: row.title, course_id: row.course_id };
  }

  if (src.type === "material") {
    const row = db.prepare("SELECT title, course_id, text FROM materials WHERE id = ?").get(src.id) as
      | { title: string; course_id: string | null; text: string | null }
      | undefined;
    if (!row) return null;
    return { text: row.text ?? "", title: row.title.replace(/\.[a-z0-9]+$/i, ""), course_id: row.course_id };
  }

  if (src.type === "note") {
    const row = db.prepare("SELECT title, course_id, body FROM notes WHERE id = ?").get(src.id) as
      | { title: string; course_id: string | null; body: string }
      | undefined;
    if (!row) return null;
    return { text: row.body, title: row.title, course_id: row.course_id };
  }

  // Whole course: lecture notes + slide text, newest first, capped.
  const course = db.prepare("SELECT name, code FROM courses WHERE id = ?").get(src.id) as
    | { name: string; code: string | null }
    | undefined;
  if (!course) return null;
  const parts: string[] = [];
  const lectures = db
    .prepare(
      `SELECT l.title, COALESCE(t.summary, t.text) AS body FROM lectures l
       JOIN transcripts t ON t.lecture_id = l.id
       WHERE l.course_id = ? AND COALESCE(t.summary, t.text) IS NOT NULL
       ORDER BY l.recorded_at DESC LIMIT 20`,
    )
    .all(src.id) as { title: string; body: string }[];
  for (const l of lectures) parts.push(`## ${l.title}\n${l.body}`);
  const mats = db
    .prepare(
      "SELECT title, text FROM materials WHERE course_id = ? AND text IS NOT NULL ORDER BY week LIMIT 20",
    )
    .all(src.id) as { title: string; text: string }[];
  for (const m of mats) parts.push(`## ${m.title}\n${m.text}`);

  return {
    text: parts.join("\n\n"),
    title: `${course.code || course.name} — course deck`,
    course_id: src.id,
  };
}

/* --- Exports -------------------------------------------------------------- */

/**
 * Quizlet's importer takes plain text with a term/definition separator and a
 * card separator. Tab + newline is its default, so a paste needs no fiddling.
 *
 * (Quizlet withdrew its public write API in 2021, so importing is the only way
 * an app can get cards into a set — there's no endpoint to create one.)
 */
export function toQuizlet(cards: { q: string; a: string }[]): string {
  return cards.map((c) => `${oneLine(c.q)}\t${oneLine(c.a)}`).join("\n");
}

/** Anki's "Basic" note type imports a two-column CSV directly. */
export function toAnkiCsv(cards: { q: string; a: string }[]): string {
  const cell = (s: string) => `"${oneLine(s).replace(/"/g, '""')}"`;
  return cards.map((c) => `${cell(c.q)},${cell(c.a)}`).join("\n");
}

/** Both formats are line-based, so a card can't contain a newline or tab. */
function oneLine(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function deckCards(deckId: string): { q: string; a: string }[] {
  return getDb()
    .prepare("SELECT q, a FROM cards WHERE deck_id = ? ORDER BY rowid")
    .all(deckId) as { q: string; a: string }[];
}
