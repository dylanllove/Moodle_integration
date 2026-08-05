import { getDb, getSetting } from "@uni/db";

/**
 * How many cards a day, and which.
 *
 * Every card a deck generator makes starts with no due date, which the reviewer
 * reads as "due now". One semester of auto-generated decks therefore arrives as
 * 438 cards due simultaneously, none of them ever reviewed — which is not spaced
 * repetition, it's a backlog, and a backlog that size is one you don't start.
 *
 * So new cards are *introduced* at a rate instead of dumped. A day's queue is
 * everything genuinely due for review, plus a bounded number of cards you've
 * never seen. The bound rises as an assessment approaches — the point of covering
 * material at a steady pace is to have covered it by the test, so if the test is
 * close the pace has to go up, and if there isn't time to see everything once
 * that's worth saying rather than hiding.
 */

/** New cards per course per day when nothing is imminent. */
const BASE_NEW_PER_DAY = 15;
/** Never introduce more than this in one day, however close the test is. */
const MAX_NEW_PER_DAY = 60;
/** Inside this many days of an assessment, pace to finish the material. */
const RAMP_WINDOW_DAYS = 21;

export function newPerDayBase(): number {
  const raw = Number(getSetting("cards_new_per_day"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(MAX_NEW_PER_DAY, Math.round(raw)) : BASE_NEW_PER_DAY;
}

export interface CourseIntake {
  courseId: string | null;
  /** New cards allowed today. */
  allowance: number;
  /** Already introduced today. */
  introducedToday: number;
  /** Still available today. */
  remaining: number;
  /** Cards never seen, in total. */
  unseen: number;
  daysToNext: number | null;
  /** True when there aren't enough days left to see everything once. */
  behind: boolean;
  reason: string;
}

/**
 * The day's allowance for one course.
 *
 * Pace = unseen cards ÷ days remaining, floored at the base rate, so a quiet
 * course ticks along at fifteen and a course with a test on Friday asks for as
 * many as the remaining days require.
 */
export function intakeFor(courseId: string | null): CourseIntake {
  const db = getDb();
  const scope = courseId ? "AND dk.course_id = ?" : "AND dk.course_id IS NULL";
  const args = courseId ? [courseId] : [];

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN ca.introduced_at IS NULL THEN 1 ELSE 0 END) AS unseen,
         SUM(CASE WHEN date(ca.introduced_at) = date('now','localtime') THEN 1 ELSE 0 END) AS today
       FROM cards ca JOIN decks dk ON dk.id = ca.deck_id
       WHERE 1=1 ${scope}`,
    )
    .get(...args) as { unseen: number | null; today: number | null };

  const unseen = counts.unseen ?? 0;
  const introducedToday = counts.today ?? 0;
  const days = courseId ? daysToNextAssessment(courseId) : null;
  const base = newPerDayBase();

  let allowance = base;
  let reason = `${base} new cards a day`;
  let behind = false;

  if (days != null && days <= RAMP_WINDOW_DAYS && unseen > 0) {
    // Aim to have seen everything at least once by the day before.
    const daysLeft = Math.max(1, days);
    const needed = Math.ceil(unseen / daysLeft);
    if (needed > base) {
      allowance = Math.min(MAX_NEW_PER_DAY, needed);
      reason = `${allowance} today — ${unseen} cards unseen and ${daysLeft} day${daysLeft === 1 ? "" : "s"} until the next assessment`;
    }
    if (needed > MAX_NEW_PER_DAY) {
      behind = true;
      reason = `${MAX_NEW_PER_DAY} today — ${unseen} unseen in ${daysLeft} day${daysLeft === 1 ? "" : "s"} is more than a day's study can cover, so prioritise`;
    }
  }

  return {
    courseId,
    allowance,
    introducedToday,
    remaining: Math.max(0, allowance - introducedToday),
    unseen,
    daysToNext: days,
    behind,
    reason,
  };
}

function daysToNextAssessment(courseId: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT MIN(at) AS at FROM (
         SELECT start_at AS at FROM events
          WHERE course_id = ? AND kind IN ('deadline','exam') AND start_at >= datetime('now')
         UNION ALL
         SELECT due_at AS at FROM assessments
          WHERE course_id = ? AND due_at IS NOT NULL AND due_at >= datetime('now')
       )`,
    )
    .get(courseId, courseId) as { at: string | null };
  if (!row.at) return null;
  return Math.max(0, Math.floor((Date.parse(row.at) - Date.now()) / 864e5));
}

/* --- What's actually available ---------------------------------------------- */

export interface Availability {
  /** Cards seen before and now due again. */
  reviewDue: number;
  /** New cards today's allowance still permits. */
  newAvailable: number;
  total: number;
}

/**
 * How many cards a deck or course can offer right now. This is the number the UI
 * should show: "438 due" was true of the table and false of the day.
 */
export function availability(opts: { deck_id?: string; course_id?: string }): Availability {
  const db = getDb();
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.deck_id) {
    clauses.push("ca.deck_id = ?");
    args.push(opts.deck_id);
  }
  if (opts.course_id) {
    clauses.push("dk.course_id = ?");
    args.push(opts.course_id);
  }
  const where = clauses.length ? `AND ${clauses.join(" AND ")}` : "";

  const reviewDue = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM cards ca JOIN decks dk ON dk.id = ca.deck_id
          WHERE ca.introduced_at IS NOT NULL
            AND (ca.due_at IS NULL OR ca.due_at <= datetime('now'))
            ${where}`,
      )
      .get(...args) as { n: number }
  ).n;

  // A deck's new-card allowance belongs to its course, not the deck: five decks
  // in one paper shouldn't mean five times the intake.
  const courseId =
    opts.course_id ??
    (opts.deck_id
      ? ((db.prepare("SELECT course_id FROM decks WHERE id = ?").get(opts.deck_id) as
          | { course_id: string | null }
          | undefined)?.course_id ?? null)
      : null);
  const intake = intakeFor(courseId);

  const unseenHere = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM cards ca JOIN decks dk ON dk.id = ca.deck_id
          WHERE ca.introduced_at IS NULL ${where}`,
      )
      .get(...args) as { n: number }
  ).n;

  const newAvailable = Math.min(intake.remaining, unseenHere);
  return { reviewDue, newAvailable, total: reviewDue + newAvailable };
}

/**
 * Stamp a card as seen. Called on its first review, which is what makes the daily
 * allowance mean anything.
 */
export function markIntroduced(cardId: string): void {
  getDb()
    .prepare("UPDATE cards SET introduced_at = datetime('now') WHERE id = ? AND introduced_at IS NULL")
    .run(cardId);
}

/**
 * Bring an existing library under the schedule.
 *
 * Cards made before any of this exist with no introduced_at, which is correct —
 * they haven't been seen. But cards that *have* been reviewed need stamping, or
 * they'd be treated as new forever and eat the daily allowance.
 */
export function backfillIntroduced(): number {
  return getDb()
    .prepare(
      "UPDATE cards SET introduced_at = datetime('now','-30 days') WHERE introduced_at IS NULL AND reviews > 0",
    )
    .run().changes as number;
}
