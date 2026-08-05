import { getDb } from "@uni/db";
import { courseGrades } from "./grades.js";
import { availability, intakeFor } from "./card-schedule.js";

/**
 * What to do today.
 *
 * Everything else in this app answers a question you have to think to ask: how
 * heavy is this week, what's due, which cards are waiting, what did that lecture
 * say. The gap between that and an assistant is that an assistant has an opinion
 * — it looks at a deadline two days out worth 4%, a lecture from Friday whose
 * cards have never been turned over, and a course whose weightings nobody has
 * entered, and it says which of those to do first and why.
 *
 * Deliberately arithmetic rather than a model. A plan you can't interrogate is a
 * plan you won't trust at 9am, every reason here is traceable to a number, and it
 * keeps working when the OpenAI credits run out — which is exactly when a student
 * still needs to know what to study.
 */

export type ActionKind =
  | "deadline"
  | "exam-prep"
  | "review"
  | "study-lecture"
  | "setup-gap";

export interface PlanAction {
  /** Stable within a day, so "done" can be remembered. */
  key: string;
  kind: ActionKind;
  title: string;
  /** The one-line justification. This is the whole point. */
  why: string;
  courseId: string | null;
  courseCode: string | null;
  /** Rough minutes, so a plan can be sized against an evening. */
  minutes: number;
  /** Where to go and do it. */
  to: string;
  priority: number;
  done: boolean;
}

export interface CourseReadiness {
  courseId: string;
  courseCode: string | null;
  /** Days until the next assessment, null if nothing is scheduled. */
  daysToNext: number | null;
  nextTitle: string | null;
  /** Share of this course's cards that have been reviewed at least once, 0–1. */
  seen: number;
  /** Share sitting in box 3 or above — actually retained rather than met once. */
  strong: number;
  cards: number;
  /** False when no weightings are known, which blanks the grade calculator. */
  weightsKnown: boolean;
  /** Plain-language verdict, for the student rather than for the maths. */
  verdict: "not started" | "behind" | "getting there" | "on top of it" | "nothing due";
}

export interface StudyPlan {
  date: string;
  actions: PlanAction[];
  readiness: CourseReadiness[];
  /** Sum of the suggested minutes still outstanding. */
  minutes: number;
  /** Hours of class and commitments already on today. */
  committedHours: number;
  headline: string;
}

/** A plan longer than this stops being a plan and becomes a list. */
const MAX_ACTIONS = 6;
/** Cards per sitting — matches the reviewer's own session size. */
const SESSION_CARDS = 60;
/** Roughly how long a card takes, once you're going. */
const MINUTES_PER_CARD = 0.4;
/** How far ahead a deadline starts mattering today. */
const DEADLINE_HORIZON_DAYS = 10;
/** An exam this far out is worth starting on. */
const EXAM_HORIZON_DAYS = 21;

export function buildPlan(dayIso?: string): StudyPlan {
  const db = getDb();
  // For today, reason from the actual moment. Anchoring to noon whenever a date
  // is passed made every figure jump the instant you ticked something off —
  // "due tomorrow" became "due in 2 days" because the clock moved, not the world.
  const today = iso(new Date());
  const now = !dayIso || dayIso === today ? new Date() : new Date(`${dayIso}T12:00:00`);
  const day = iso(now);
  const doneKeys = new Set(
    (db.prepare("SELECT key FROM plan_done WHERE day = ?").all(day) as { key: string }[]).map(
      (r) => r.key,
    ),
  );

  const courses = db
    .prepare("SELECT id, code, name FROM courses WHERE active = 1 ORDER BY code")
    .all() as { id: string; code: string | null; name: string }[];
  const codeOf = (id: string | null) => courses.find((c) => c.id === id)?.code ?? null;
  const isActive = (id: string | null) => Boolean(id && courses.some((c) => c.id === id));

  const actions: PlanAction[] = [];
  const weightByCourse = weightIndex();

  /* --- What's due ---------------------------------------------------------- */

  for (const d of upcoming(now)) {
    if (!isActive(d.courseId)) continue;
    const days = daysBetween(now, new Date(d.at));
    if (days > (d.kind === "exam" ? EXAM_HORIZON_DAYS : DEADLINE_HORIZON_DAYS)) continue;

    const weight = weightByCourse.get(`${d.courseId}|${normalise(d.title)}`) ?? null;
    const isExam = d.kind === "exam";
    // Urgency dominates, and it has to bite hard: something due tomorrow is not
    // 10% more pressing than something due in ten days.
    const urgency = 120 / (Math.max(0, days) + 1);
    const stakes = weight ?? (isExam ? 40 : 8);
    actions.push({
      key: `deadline:${d.id}`,
      kind: isExam ? "exam-prep" : "deadline",
      title: isExam ? `Revise for ${d.title}` : d.title,
      why: [
        days <= 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`,
        weight != null ? `worth ${round1(weight)}%` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      courseId: d.courseId,
      courseCode: codeOf(d.courseId),
      minutes: isExam ? 60 : days <= 1 ? 90 : 45,
      to: isExam
        ? `/flashcards?course=${encodeURIComponent(d.courseId ?? "")}`
        : d.assignmentId
          ? `/assistant?assignment=${encodeURIComponent(d.assignmentId)}`
          : // No brief to open — land on the day it's due rather than nowhere.
            `/calendar?focus=${d.at.slice(0, 10)}`,
      priority: urgency * 3 + stakes * 1.2,
      done: doneKeys.has(`deadline:${d.id}`),
    });
  }

  /* --- Material you haven't touched --------------------------------------- */

  const unstudied = db
    .prepare(
      `SELECT l.id, l.title, l.course_id, l.recorded_at,
              (SELECT COUNT(*) FROM cards ca JOIN decks dk ON dk.id = ca.deck_id
                WHERE dk.lecture_id = l.id) AS cards,
              (SELECT COALESCE(SUM(ca.reviews), 0) FROM cards ca JOIN decks dk ON dk.id = ca.deck_id
                WHERE dk.lecture_id = l.id) AS reviews
         FROM lectures l
         JOIN transcripts t ON t.lecture_id = l.id
        WHERE t.summary IS NOT NULL
        ORDER BY l.recorded_at IS NULL, l.recorded_at DESC
        LIMIT 40`,
    )
    .all() as {
    id: string;
    title: string;
    course_id: string | null;
    recorded_at: string | null;
    cards: number;
    reviews: number;
  }[];

  for (const l of unstudied) {
    if (!isActive(l.course_id) || l.reviews > 0) continue;
    const age = l.recorded_at ? daysBetween(new Date(l.recorded_at), now) : 999;
    // Reviewing within a few days of the lecture is worth far more than later,
    // so recency is the signal here rather than urgency.
    const recency = age <= 2 ? 60 : age <= 7 ? 35 : age <= 21 ? 15 : 5;
    actions.push({
      key: `lecture:${l.id}`,
      kind: "study-lecture",
      title: `Go over “${l.title}”`,
      why:
        (age <= 1 ? "from today" : age <= 7 ? `${age} days ago` : "never studied") +
        (l.cards > 0 ? ` · ${l.cards} cards ready, none turned over` : " · notes ready"),
      courseId: l.course_id,
      courseCode: codeOf(l.course_id),
      minutes: l.cards > 0 ? 15 : 10,
      to: `/lectures?lecture=${encodeURIComponent(l.id)}`,
      priority: recency,
      done: doneKeys.has(`lecture:${l.id}`),
    });
  }

  /* --- Cards waiting ------------------------------------------------------- */

  for (const course of courses) {
    // Today's queue, not the whole library: suggesting "drill 139 cards" is how
    // a plan gets ignored.
    const today = availability({ course_id: course.id });
    if (today.total === 0) continue;
    const intake = intakeFor(course.id);
    const soon = soonestDays(now, course.id);
    const size = Math.min(SESSION_CARDS, today.total);
    const pressure = soon == null ? 12 : Math.max(12, 70 / (soon + 1));
    actions.push({
      key: `review:${course.id}`,
      kind: "review",
      title: `Drill ${size} ${course.code ?? ""} cards`.trim(),
      why: [
        today.reviewDue > 0 ? `${today.reviewDue} to revisit` : null,
        today.newAvailable > 0 ? `${today.newAvailable} new` : null,
        intake.behind
          ? `${intake.unseen} still unseen with ${soon}d to go — prioritise`
          : soon != null
            ? `next assessment in ${soon} day${soon === 1 ? "" : "s"}`
            : null,
      ]
        .filter(Boolean)
        .join(" · "),
      courseId: course.id,
      courseCode: course.code,
      minutes: Math.round(size * MINUTES_PER_CARD),
      to: `/flashcards?course=${encodeURIComponent(course.id)}`,
      // A course that can't cover its material in time should shout.
      priority: pressure + (intake.behind ? 25 : 0),
      done: doneKeys.has(`review:${course.id}`),
    });
  }

  /* --- Gaps that make everything else guesswork --------------------------- */

  // One row, however many courses. Three lines all saying "set up weightings"
  // are three lines of nagging that push the actual studying off the list.
  const missing = courses.filter((c) => !weightsKnown(c.id));
  if (missing.length) {
    const names = missing.map((c) => c.code ?? c.name);
    actions.push({
      key: "weights:all",
      kind: "setup-gap",
      title:
        missing.length === 1
          ? `Set up ${names[0]} weightings`
          : `Set up weightings for ${missing.length} courses`,
      why: `${names.join(", ")} — until these are in, nothing can tell you what you need to pass. One tap reads it out of the course outline.`,
      courseId: missing.length === 1 ? missing[0]!.id : null,
      courseCode: missing.length === 1 ? missing[0]!.code : null,
      minutes: 2 * missing.length,
      to: missing.length === 1 ? `/grades?course=${encodeURIComponent(missing[0]!.id)}` : "/grades",
      // High, because every grade answer for those courses is blank until it's
      // done, but below anything actually due.
      priority: 55,
      done: doneKeys.has("weights:all"),
    });
  }

  /* --- Assemble ------------------------------------------------------------ */

  const ranked = actions
    .sort((a, b) => b.priority - a.priority)
    .filter((a, i, all) => all.findIndex((x) => x.key === a.key) === i);

  // One action per course per kind, so a plan can't be six cards-drills.
  const seen = new Set<string>();
  const chosen: PlanAction[] = [];
  for (const a of ranked) {
    const slot = `${a.kind}|${a.courseId ?? "none"}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    chosen.push(a);
    if (chosen.filter((x) => !x.done).length >= MAX_ACTIONS) break;
  }

  const outstanding = chosen.filter((a) => !a.done);
  const readiness = courses.map((c) => readinessFor(c.id, c.code, now));

  return {
    date: day,
    actions: chosen,
    readiness,
    minutes: outstanding.reduce((s, a) => s + a.minutes, 0),
    committedHours: committedHoursOn(now),
    headline: headlineFor(outstanding, readiness),
  };
}

/* --- Readiness ------------------------------------------------------------- */

function readinessFor(courseId: string, code: string | null, now: Date): CourseReadiness {
  const db = getDb();
  const cards = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ca.reviews > 0 THEN 1 ELSE 0 END) AS seen,
              SUM(CASE WHEN ca.box >= 3 THEN 1 ELSE 0 END) AS strong
         FROM cards ca JOIN decks dk ON dk.id = ca.deck_id
        WHERE dk.course_id = ?`,
    )
    .get(courseId) as { total: number; seen: number | null; strong: number | null };

  const total = cards.total ?? 0;
  const seen = total ? (cards.seen ?? 0) / total : 0;
  const strong = total ? (cards.strong ?? 0) / total : 0;
  const next = nextAssessment(now, courseId);
  const days = next ? daysBetween(now, new Date(next.at)) : null;

  let verdict: CourseReadiness["verdict"];
  if (days == null) verdict = "nothing due";
  else if (total === 0 || seen === 0) verdict = "not started";
  else if (days <= 7 && strong < 0.5) verdict = "behind";
  else if (strong < 0.6) verdict = "getting there";
  else verdict = "on top of it";

  return {
    courseId,
    courseCode: code,
    daysToNext: days,
    nextTitle: next?.title ?? null,
    seen: round2(seen),
    strong: round2(strong),
    cards: total,
    weightsKnown: weightsKnown(courseId),
    verdict,
  };
}

/**
 * The line at the top. Says the most useful true thing about today rather than
 * greeting the student — "nothing due, get ahead" is as much a plan as a list of
 * six tasks, and pretending otherwise is how an assistant loses credibility.
 */
function headlineFor(outstanding: PlanAction[], readiness: CourseReadiness[]): string {
  const urgent = outstanding.find((a) => a.kind === "deadline" && /due (today|tomorrow)/.test(a.why));
  if (urgent) {
    return `${urgent.courseCode ?? "Something"} is ${urgent.why.split(" · ")[0]} — start there.`;
  }
  const behind = readiness.filter((r) => r.verdict === "behind");
  if (behind.length) {
    const worst = behind.sort((a, b) => (a.daysToNext ?? 99) - (b.daysToNext ?? 99))[0]!;
    return `${worst.courseCode} has something in ${worst.daysToNext} days and you've retained ${Math.round(worst.strong * 100)}% of its cards.`;
  }
  // Count the courses, not the rows: the gaps are collapsed into one action, and
  // saying "1 course" above a row that lists three is its own small betrayal.
  const gapCourses = readiness.filter((r) => !r.weightsKnown).length;
  if (gapCourses && outstanding.some((a) => a.kind === "setup-gap")) {
    return `${gapCourses} course${gapCourses === 1 ? "" : "s"} still ${gapCourses === 1 ? "has" : "have"} no weightings — that's the one thing blocking every grade answer.`;
  }
  if (!outstanding.length) return "Nothing pressing today. A quiet day is the cheapest time to get ahead.";
  const mins = outstanding.reduce((s, a) => s + a.minutes, 0);
  return `About ${formatMinutes(mins)} of study would keep you on top of everything.`;
}

/* --- Data helpers ---------------------------------------------------------- */

interface Due {
  id: string;
  title: string;
  kind: "deadline" | "exam";
  at: string;
  courseId: string | null;
  assignmentId: string | null;
}

/** Deadlines and exams from both the calendar and the assessment table, deduped. */
function upcoming(now: Date): Due[] {
  const db = getDb();
  const out: Due[] = [];
  const seen = new Set<string>();

  const events = db
    .prepare(
      `SELECT e.id, e.title, e.kind, e.start_at, e.course_id,
              (SELECT a.id FROM assignments a
                WHERE a.course_id = e.course_id AND a.due_at = e.start_at LIMIT 1) AS assignment_id
         FROM events e
        WHERE e.kind IN ('deadline','exam') AND e.start_at >= ?
        ORDER BY e.start_at`,
    )
    .all(now.toISOString()) as {
    id: string;
    title: string;
    kind: string;
    start_at: string;
    course_id: string | null;
    assignment_id: string | null;
  }[];

  for (const e of events) {
    const clean = stripDecoration(e.title);
    const key = `${e.course_id}|${normalise(clean)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id,
      title: clean,
      kind: e.kind === "exam" ? "exam" : "deadline",
      at: e.start_at,
      courseId: e.course_id,
      assignmentId: e.assignment_id,
    });
  }

  const assessments = db
    .prepare(
      `SELECT id, title, course_id, due_at, is_final FROM assessments
        WHERE due_at IS NOT NULL AND due_at >= ? ORDER BY due_at`,
    )
    .all(now.toISOString()) as {
    id: string;
    title: string;
    course_id: string | null;
    due_at: string;
    is_final: number;
  }[];

  for (const a of assessments) {
    const key = `${a.course_id}|${normalise(a.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: a.id,
      title: a.title,
      kind: a.is_final ? "exam" : "deadline",
      at: a.due_at,
      courseId: a.course_id,
      assignmentId: null,
    });
  }
  return out.sort((x, y) => x.at.localeCompare(y.at));
}

function nextAssessment(now: Date, courseId: string): { title: string; at: string } | null {
  const all = upcoming(now).filter((d) => d.courseId === courseId);
  return all[0] ? { title: all[0].title, at: all[0].at } : null;
}

function soonestDays(now: Date, courseId: string | null): number | null {
  if (!courseId) return null;
  const next = nextAssessment(now, courseId);
  return next ? daysBetween(now, new Date(next.at)) : null;
}

/** Resolved weights by course and title, so a plan can say what's at stake. */
function weightIndex(): Map<string, number> {
  const out = new Map<string, number>();
  for (const course of courseGrades()) {
    for (const a of course.assessments) {
      if (a.effectiveWeight > 0) {
        out.set(`${course.course_id}|${normalise(a.title)}`, a.effectiveWeight);
        out.set(`${course.course_id}|${normalise(stripDecoration(a.title))}`, a.effectiveWeight);
      }
    }
  }
  return out;
}

function weightsKnown(courseId: string): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM assessments WHERE course_id = ? AND weight IS NOT NULL")
    .get(courseId) as { n: number };
  return row.n > 0;
}

/** Classes and commitments already on the day — what's left to study around. */
function committedHoursOn(now: Date): number {
  const start = `${iso(now)}T00:00:00`;
  const end = `${iso(now)}T23:59:59`;
  const rows = getDb()
    .prepare(
      `SELECT start_at, end_at FROM events
        WHERE kind = 'class' AND start_at BETWEEN ? AND ?`,
    )
    .all(start, end) as { start_at: string; end_at: string | null }[];
  let hours = 0;
  for (const r of rows) {
    if (!r.end_at) {
      hours += 1;
      continue;
    }
    const ms = new Date(r.end_at).getTime() - new Date(r.start_at).getTime();
    if (ms > 0 && ms < 12 * 3600_000) hours += ms / 3600_000;
  }
  return Math.round(hours * 10) / 10;
}

/* --- Marking things off ---------------------------------------------------- */

export function markDone(day: string, key: string, done: boolean): void {
  const db = getDb();
  if (done) {
    db.prepare(
      "INSERT INTO plan_done (day, key, done_at) VALUES (?,?,datetime('now')) ON CONFLICT(day, key) DO NOTHING",
    ).run(day, key);
  } else {
    db.prepare("DELETE FROM plan_done WHERE day = ? AND key = ?").run(day, key);
  }
}

/* --- Small stuff ----------------------------------------------------------- */

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whole days between two instants, floored — "due in 0 days" means today. */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 864e5);
}

/** Moodle decorates the same assessment several ways; compare without them. */
function stripDecoration(title: string): string {
  return title
    .replace(/^(due|opens|closes)\s*:\s*/i, "")
    .replace(/\s*\((due date|opens|closes|submission)\)\s*$/i, "")
    .replace(/\s+(is|are)\s+due\s*$/i, "")
    .replace(/\s+due\s*$/i, "")
    .trim();
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
