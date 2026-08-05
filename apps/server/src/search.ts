import { getDb } from "@uni/db";
import { retrieve } from "@uni/ai";
import { describeSource, type SourceRef } from "./sources.js";

/**
 * One search across everything the app knows about.
 *
 * Fourteen courses, dozens of files and hundreds of transcript chunks are spread
 * over eleven pages, each with its own filter box. Typing a word and being taken
 * to the thing is the difference between a library and a filing cabinet — so
 * this searches names *and* content, and every hit knows where it lives.
 */
export type SearchGroup =
  | "course"
  | "deadline"
  | "class"
  | "assignment"
  | "lecture"
  | "material"
  | "note"
  | "deck"
  | "content";

export interface SearchHit {
  id: string;
  group: SearchGroup;
  title: string;
  subtitle: string | null;
  /** Small right-hand tag: the course code, a due date, a week number. */
  badge: string | null;
  /** In-app destination for the router. */
  to: string | null;
  /** External destination (Moodle) when there's no in-app view. */
  href: string | null;
  /** Matching prose, for content hits. */
  snippet: string | null;
  score: number;
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Score one record against the query. Every query token must land somewhere or
 * the record is out — with a corpus this small, "matches all the words" is a
 * better filter than any amount of ranking cleverness.
 */
function scoreFields(
  queryTokens: string[],
  fields: { text: string | null | undefined; weight: number }[],
): number {
  let total = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const f of fields) {
      if (!f.text) continue;
      const hay = f.text.toLowerCase();
      const at = hay.indexOf(token);
      if (at < 0) continue;
      const whole = hay === token;
      const atStart = at === 0;
      // A match at a word boundary beats one buried mid-word ("info" in
      // "INFO253" should outrank "info" in "reinforcement").
      const boundary = atStart || !/[a-z0-9]/.test(hay[at - 1] ?? "");
      const quality = whole ? 4 : atStart ? 3 : boundary ? 2 : 1;
      best = Math.max(best, quality * f.weight);
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

const shortDate = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }) : null;

export function search(query: string, limit = 24): SearchHit[] {
  const q = query.trim();
  const tokens = tokenize(q);
  if (tokens.length === 0) return [];

  const db = getDb();
  const hits: SearchHit[] = [];

  const courses = db
    .prepare("SELECT id, code, name, url, active FROM courses")
    .all() as { id: string; code: string | null; name: string; url: string | null; active: number }[];
  const codeOf = (id: string | null) => courses.find((c) => c.id === id)?.code ?? null;
  // Inactive courses still match, they just sit below everything current.
  const activeBoost = (id: string | null) => (courses.find((c) => c.id === id)?.active ? 1 : 0.45);

  // --- Courses -------------------------------------------------------------
  // A course code is a shortcut, not a destination: typing "MGMT244" means
  // "show me MGMT244's <something>", so each match opens as its own few doors.
  const COURSE_DOORS = [
    { label: "course files", to: (id: string) => `/materials?course=${encodeURIComponent(id)}` },
    { label: "lectures", to: (id: string) => `/lectures?course=${encodeURIComponent(id)}` },
    { label: "grades", to: (id: string) => `/grades?course=${encodeURIComponent(id)}` },
  ];
  const courseMatches = courses
    .map((c) => ({
      c,
      score: scoreFields(tokens, [
        { text: c.code, weight: 6 },
        { text: c.name, weight: 4 },
      ]),
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score * activeBoost(b.c.id) - a.score * activeBoost(a.c.id))
    .slice(0, 2);
  for (const { c, score } of courseMatches) {
    for (const door of COURSE_DOORS) {
      hits.push({
        id: `course:${c.id}:${door.label}`,
        group: "course",
        title: `${c.code ?? c.name} · ${door.label}`,
        subtitle: c.code ? c.name : null,
        badge: c.active ? null : "past course",
        to: door.to(c.id),
        href: null,
        snippet: null,
        score: score * 3 * activeBoost(c.id),
      });
    }
  }

  // --- Assignments ---------------------------------------------------------
  const assignments = db
    .prepare("SELECT id, course_id, title, brief, url, due_at FROM assignments")
    .all() as {
    id: string;
    course_id: string | null;
    title: string;
    brief: string | null;
    url: string | null;
    due_at: string | null;
  }[];
  for (const a of assignments) {
    const score = scoreFields(tokens, [
      { text: a.title, weight: 5 },
      { text: codeOf(a.course_id), weight: 3 },
      { text: a.brief?.slice(0, 4000), weight: 1 },
    ]);
    if (!score) continue;
    hits.push({
      id: `assignment:${a.id}`,
      group: "assignment",
      title: a.title,
      subtitle: codeOf(a.course_id),
      badge: shortDate(a.due_at) && `due ${shortDate(a.due_at)}`,
      to: `/assistant?assignment=${encodeURIComponent(a.id)}`,
      href: a.url,
      snippet: null,
      score: score * 2.2 * activeBoost(a.course_id),
    });
  }

  // --- Calendar: deadlines, exams, classes ---------------------------------
  const events = db
    .prepare(
      `SELECT id, course_id, title, kind, start_at, location FROM events
       WHERE start_at >= datetime('now', '-30 days') ORDER BY start_at LIMIT 4000`,
    )
    .all() as {
    id: string;
    course_id: string | null;
    title: string;
    kind: string;
    start_at: string;
    location: string | null;
  }[];
  // A weekly class appears dozens of times; the student wants the class, not
  // every instance of it, so only the next occurrence of each is kept.
  const seenClass = new Set<string>();
  for (const e of events) {
    const isClass = e.kind === "class";
    if (isClass) {
      const key = `${e.course_id}|${e.title}|${e.location}`;
      if (seenClass.has(key)) continue;
      if (new Date(e.start_at).getTime() < Date.now()) continue;
      seenClass.add(key);
    }
    const score = scoreFields(tokens, [
      { text: e.title, weight: 5 },
      { text: codeOf(e.course_id), weight: 3 },
      { text: e.location, weight: 2 },
    ]);
    if (!score) continue;
    hits.push({
      id: `event:${e.id}`,
      group: isClass ? "class" : "deadline",
      title: e.title,
      subtitle: [codeOf(e.course_id), e.location].filter(Boolean).join(" · ") || null,
      badge: isClass
        ? new Date(e.start_at).toLocaleDateString([], { weekday: "short" }) +
          " " +
          new Date(e.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : shortDate(e.start_at),
      to: `/calendar?focus=${encodeURIComponent(e.start_at.slice(0, 10))}`,
      href: null,
      snippet: null,
      score: score * (isClass ? 1.4 : 2) * activeBoost(e.course_id),
    });
  }

  // --- Lectures ------------------------------------------------------------
  const lectures = db
    .prepare(
      `SELECT l.id, l.course_id, l.title, l.recorded_at,
              (SELECT status FROM transcripts t WHERE t.lecture_id = l.id) AS status
       FROM lectures l`,
    )
    .all() as {
    id: string;
    course_id: string | null;
    title: string;
    recorded_at: string | null;
    status: string | null;
  }[];
  for (const l of lectures) {
    const score = scoreFields(tokens, [
      { text: l.title, weight: 5 },
      { text: codeOf(l.course_id), weight: 3 },
    ]);
    if (!score) continue;
    hits.push({
      id: `lecture:${l.id}`,
      group: "lecture",
      title: l.title,
      subtitle: codeOf(l.course_id),
      badge: l.status === "done" ? "transcribed" : shortDate(l.recorded_at),
      to: `/lectures?lecture=${encodeURIComponent(l.id)}`,
      href: null,
      snippet: null,
      score: score * 2 * activeBoost(l.course_id),
    });
  }

  // --- Course files --------------------------------------------------------
  const materials = db
    .prepare("SELECT id, course_id, title, week, section, module, kind FROM materials")
    .all() as {
    id: string;
    course_id: string | null;
    title: string;
    week: number | null;
    section: string | null;
    module: string | null;
    kind: string;
  }[];
  for (const m of materials) {
    const score = scoreFields(tokens, [
      { text: m.title, weight: 5 },
      { text: m.module, weight: 3 },
      { text: m.section, weight: 2 },
      { text: codeOf(m.course_id), weight: 3 },
    ]);
    if (!score) continue;
    hits.push({
      id: `material:${m.id}`,
      group: "material",
      title: m.title,
      subtitle: [codeOf(m.course_id), m.module ?? m.section].filter(Boolean).join(" · ") || null,
      badge: m.week ? `Week ${String(m.week).padStart(2, "0")}` : m.kind,
      to: `/materials?open=${encodeURIComponent(m.id)}`,
      href: null,
      snippet: null,
      score: score * 2 * activeBoost(m.course_id),
    });
  }

  // --- Notes & cheat sheets ------------------------------------------------
  const notes = db.prepare("SELECT id, course_id, title, body FROM notes").all() as {
    id: string;
    course_id: string | null;
    title: string;
    body: string;
  }[];
  for (const n of notes) {
    const score = scoreFields(tokens, [
      { text: n.title, weight: 5 },
      { text: codeOf(n.course_id), weight: 3 },
      { text: n.body.slice(0, 6000), weight: 1 },
    ]);
    if (!score) continue;
    hits.push({
      id: `note:${n.id}`,
      group: "note",
      title: n.title || "Untitled note",
      subtitle: codeOf(n.course_id),
      badge: /^cheat sheet/i.test(n.title) ? "cheat sheet" : null,
      to: `/notes?note=${encodeURIComponent(n.id)}`,
      href: null,
      snippet: null,
      score: score * 2 * activeBoost(n.course_id),
    });
  }

  // --- Flashcard decks -----------------------------------------------------
  const decks = db
    .prepare(
      `SELECT d.id, d.course_id, d.title,
              (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS cards
       FROM decks d`,
    )
    .all() as { id: string; course_id: string | null; title: string; cards: number }[];
  for (const d of decks) {
    const score = scoreFields(tokens, [
      { text: d.title, weight: 5 },
      { text: codeOf(d.course_id), weight: 3 },
    ]);
    if (!score) continue;
    hits.push({
      id: `deck:${d.id}`,
      group: "deck",
      title: d.title,
      subtitle: codeOf(d.course_id),
      badge: `${d.cards} cards`,
      to: `/flashcards?deck=${encodeURIComponent(d.id)}`,
      href: null,
      snippet: null,
      score: score * 1.8 * activeBoost(d.course_id),
    });
  }

  // --- Inside the content --------------------------------------------------
  // Slides, transcripts and notes, by what they actually say. Ranked below the
  // named results because a title match is a stronger signal of intent.
  for (const chunk of retrieve(q, null, 6)) {
    const ref = describeSource(chunk.sourceType, chunk.sourceId);
    if (!ref || (!ref.to && !ref.href)) continue;
    hits.push({
      id: `content:${chunk.sourceType}:${chunk.sourceId}:${hits.length}`,
      group: "content",
      title: ref.label,
      subtitle: ref.courseCode,
      badge: SOURCE_LABEL[ref.kind],
      to: ref.to,
      href: ref.href,
      snippet: highlightWindow(chunk.text, tokens),
      score: chunk.score * 6 * activeBoost(ref.courseId),
    });
  }

  // One row per destination — a lecture that matched by title and by transcript
  // should be offered once.
  const byDestination = new Map<string, SearchHit>();
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    const key = h.to ?? h.href ?? h.id;
    const existing = byDestination.get(key);
    if (!existing) byDestination.set(key, h);
    // Keep the higher-ranked row but don't lose a snippet the loser carried.
    else if (!existing.snippet && h.snippet) existing.snippet = h.snippet;
  }

  return [...byDestination.values()].slice(0, limit);
}

const SOURCE_LABEL: Record<SourceRef["kind"], string> = {
  material: "in a file",
  lecture: "in a lecture",
  note: "in a note",
  "course-page": "on a course page",
};

/** ~200 characters of the chunk centred on the first query token that appears. */
function highlightWindow(text: string, tokens: string[]): string {
  const hay = text.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = hay.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 200).trim();
  const start = Math.max(0, at - 70);
  const body = text.slice(start, start + 200).trim();
  return `${start > 0 ? "…" : ""}${body}${start + 200 < text.length ? "…" : ""}`;
}
