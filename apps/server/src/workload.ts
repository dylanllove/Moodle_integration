import { getDb } from "@uni/db";
import { courseGrades } from "./grades.js";

/**
 * Workload heatmap: which weeks are about to get brutal, across every course
 * *and* your life outside them.
 *
 * The score is in **estimated hours of demand** rather than an abstract 1–5,
 * because hours are the thing you actually run out of. Each deadline is costed
 * from how much it's worth (a 40% report is not a 5% quiz), classes cost their
 * scheduled length, and personal commitments cost their real duration — a week
 * with three shifts and two deadlines should look as bad as it feels.
 */

/** Hours of work a deadline implies, by how much of the grade rides on it. */
function deadlineHours(weight: number | null, kind: string): number {
  if (kind === "exam") return weight != null ? clamp(weight * 0.5, 6, 30) : 12;
  if (weight == null) return 6; // unknown weighting: a middling assignment
  return clamp(weight * 0.45, 2, 25);
}

/** Personal commitments cost their real hours; classes cost their timetabled span. */
const HOURS_PER_UNKNOWN_CLASS = 1;

export interface WeekLoad {
  /** Monday of the week, ISO date (YYYY-MM-DD). */
  weekStart: string;
  weekLabel: string;
  /** Teaching week number relative to the earliest active course start. */
  teachingWeek: number | null;
  isCurrent: boolean;
  totalHours: number;
  classHours: number;
  deadlineHours: number;
  personalHours: number;
  /** Per-course hours, keyed by course id. */
  byCourse: Record<string, number>;
  /** What's driving the week, worst first — the tooltip content. */
  drivers: { title: string; course_id: string | null; kind: string; at: string; hours: number }[];
  /** 0–1, relative to the busiest week we have real data for. Drives the ramp. */
  intensity: number;
  /**
   * "unknown" means past the point your LMS has published deadlines — the week
   * isn't light, we just can't see it yet. Saying so beats implying calm.
   */
  verdict: "unknown" | "quiet" | "steady" | "busy" | "heavy" | "brutal";
}

export interface WorkloadResult {
  weeks: WeekLoad[];
  courses: { id: string; code: string | null; name: string }[];
  /** Weeks flagged as heavy or worse, soonest first — the "brace yourself" list. */
  crunch: WeekLoad[];
  /** The student's typical teaching week, in hours — every verdict is relative to it. */
  baseline: number;
  /** Monday of the last week with published deadlines; weeks after it are "unknown". */
  horizon: string | null;
}

export function computeWorkload(weeksAhead = 14, weeksBehind = 1): WorkloadResult {
  const db = getDb();
  const courses = db
    .prepare("SELECT id, code, name, start_date FROM courses WHERE active = 1 ORDER BY name")
    .all() as { id: string; code: string | null; name: string; start_date: string | null }[];

  // Weight lookup so a deadline's cost reflects what it's worth.
  const weights = new Map<string, number>();
  const finals = new Set<string>();
  for (const g of courseGrades()) {
    for (const a of g.assessments) {
      // effectiveWeight, not the raw column: a grouped item's weight is its
      // share of the group and isn't stored on the row.
      if (a.effectiveWeight > 0) weights.set(normalise(a.title), a.effectiveWeight);
      if (a.is_final) finals.add(normalise(a.title));
    }
  }

  const thisMonday = mondayOf(new Date());
  const start = addDays(thisMonday, -7 * weeksBehind);
  const end = addDays(thisMonday, 7 * (weeksAhead + 1));

  const events = db
    .prepare(
      `SELECT e.id, e.course_id, e.title, e.kind, e.source, e.start_at, e.end_at, e.notes
       FROM events e
       WHERE e.start_at >= ? AND e.start_at < ?
         AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))`,
    )
    .all(start.toISOString(), end.toISOString()) as EventRow[];

  // Earliest course start anchors "teaching week 1".
  const termStart = courses
    .map((c) => (c.start_date ? new Date(c.start_date) : null))
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  const buckets = new Map<string, WeekLoad>();
  const total = weeksBehind + weeksAhead + 1;
  for (let i = 0; i < total; i++) {
    const ws = addDays(start, i * 7);
    buckets.set(isoDate(ws), {
      weekStart: isoDate(ws),
      weekLabel: weekLabel(ws),
      teachingWeek: termStart ? teachingWeek(ws, termStart) : null,
      isCurrent: isoDate(ws) === isoDate(thisMonday),
      totalHours: 0,
      classHours: 0,
      deadlineHours: 0,
      personalHours: 0,
      byCourse: {},
      drivers: [],
      intensity: 0,
      verdict: "quiet",
    });
  }

  for (const e of events) {
    const bucket = buckets.get(isoDate(mondayOf(new Date(e.start_at))));
    if (!bucket) continue;

    let hours: number;
    let lane: "class" | "deadline" | "personal";
    if (e.kind === "personal") {
      hours = spanHours(e) ?? 1;
      lane = "personal";
    } else if (e.kind === "class") {
      hours = spanHours(e) ?? HOURS_PER_UNKNOWN_CLASS;
      lane = "class";
    } else if (e.kind === "deadline" || e.kind === "exam") {
      const key = normalise(e.title.replace(/^(Due|Opens):\s*/i, ""));
      hours = deadlineHours(weights.get(key) ?? null, finals.has(key) ? "exam" : e.kind);
      lane = "deadline";
    } else {
      continue; // 'open' dates and stray items aren't work
    }

    bucket.totalHours += hours;
    if (lane === "class") bucket.classHours += hours;
    else if (lane === "deadline") bucket.deadlineHours += hours;
    else bucket.personalHours += hours;

    if (e.course_id) bucket.byCourse[e.course_id] = (bucket.byCourse[e.course_id] ?? 0) + hours;
    // Classes are steady background load; only the lumpy stuff explains a week.
    if (lane !== "class") {
      bucket.drivers.push({
        title: e.title.replace(/^(Due|Opens):\s*/i, ""),
        course_id: e.course_id,
        kind: e.kind,
        at: e.start_at,
        hours: round1(hours),
      });
    }
  }

  const weeks = [...buckets.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  for (const w of weeks) {
    w.totalHours = round1(w.totalHours);
    w.classHours = round1(w.classHours);
    w.deadlineHours = round1(w.deadlineHours);
    w.personalHours = round1(w.personalHours);
    for (const k of Object.keys(w.byCourse)) w.byCourse[k] = round1(w.byCourse[k]!);
    w.drivers.sort((a, b) => b.hours - a.hours);
  }

  /**
   * How far ahead the LMS actually publishes deadlines. Beyond that, a week has
   * classes but no assessments *yet* — comparing it against a week that does
   * would rank the whole front of the semester as a crisis and the back half as
   * a holiday. So the horizon is found and only weeks inside it are scored.
   */
  const horizon = weeks.filter((w) => w.deadlineHours > 0).at(-1)?.weekStart ?? null;
  const known = weeks.filter((w) => horizon != null && w.weekStart <= horizon);
  const scored = known.filter((w) => w.classHours + w.deadlineHours > 0);
  const baseline = median(scored.map((w) => w.totalHours));

  // The ramp spans the range of weeks we can actually see, so the pale steps
  // aren't wasted on a student whose quietest real week is still 20 hours.
  const totals = scored.map((w) => w.totalHours);
  const lo = totals.length ? Math.min(...totals) : 0;
  const hi = totals.length ? Math.max(...totals) : 1;
  for (const w of weeks) {
    const inHorizon = horizon != null && w.weekStart <= horizon;
    w.intensity =
      inHorizon && hi > lo ? Math.min(1, Math.max(0, (w.totalHours - lo) / (hi - lo))) : 0;
    w.verdict = inHorizon ? verdictFor(w, baseline) : "unknown";
  }

  const crunch = weeks.filter(
    (w) => w.weekStart >= isoDate(thisMonday) && (w.verdict === "heavy" || w.verdict === "brutal"),
  );

  return {
    weeks,
    courses: courses.map(({ id, code, name }) => ({ id, code, name })),
    crunch,
    baseline: round1(baseline),
    horizon,
  };
}

/**
 * Five bands, judged against the student's *typical* week rather than their
 * worst. Someone with a 10-hour job and 13 hours of class carries 23 hours every
 * week — that's their normal, not a crisis, and a peak-relative scale would
 * paint the whole semester red. What matters is the excess over normal, in both
 * relative and absolute terms, so one extra tutorial doesn't trip an alarm.
 */
function verdictFor(w: WeekLoad, baseline: number): WeekLoad["verdict"] {
  if (w.totalHours <= 0) return "quiet";
  // Nothing academic on: out of term, or a break week.
  if (w.classHours + w.deadlineHours === 0) return "quiet";
  if (baseline <= 0) return w.totalHours > 0 ? "steady" : "quiet";

  const ratio = w.totalHours / baseline;
  const excess = w.totalHours - baseline;
  if (ratio >= 1.35 && excess >= 8) return "brutal";
  if (ratio >= 1.15 && excess >= 4) return "heavy";
  if (ratio >= 1.0) return "busy";
  return "steady";
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function spanHours(e: EventRow): number | null {
  if (!e.end_at) return null;
  const h = (new Date(e.end_at).getTime() - new Date(e.start_at).getTime()) / 3_600_000;
  return h > 0 && h < 14 ? h : null;
}

function teachingWeek(weekStart: Date, termStart: Date): number | null {
  const n = Math.floor((weekStart.getTime() - mondayOf(termStart).getTime()) / (7 * 864e5)) + 1;
  return n >= 1 && n <= 52 ? n : null;
}

export function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekLabel(ws: Date): string {
  const end = addDays(ws, 6);
  const sameMonth = ws.getMonth() === end.getMonth();
  const l = (d: Date, withMonth: boolean) =>
    withMonth ? d.toLocaleDateString([], { day: "numeric", month: "short" }) : String(d.getDate());
  return `${l(ws, !sameMonth)} – ${l(end, true)}`;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

type EventRow = {
  id: string;
  course_id: string | null;
  title: string;
  kind: string;
  source: string;
  start_at: string;
  end_at: string | null;
  notes: string | null;
}
