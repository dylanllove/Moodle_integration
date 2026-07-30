import { getDb, getSetting } from "@uni/db";

/**
 * Grade maths: "what do I need on the final to get an A?"
 *
 * Everything is expressed in *percentage points of the final grade*. An
 * assessment worth 30% on which you scored 24/30 marks contributes
 * 30 × (24/30) = 24 points. Add up what's banked, and the rest is arithmetic.
 */

export interface GradeBand {
  letter: string;
  min: number;
}

/**
 * NZ university scale by default (it's what this app was built against). Stored
 * as a setting so a student on a different scale can replace it wholesale.
 */
export const DEFAULT_BANDS: GradeBand[] = [
  { letter: "A+", min: 90 },
  { letter: "A", min: 85 },
  { letter: "A-", min: 80 },
  { letter: "B+", min: 75 },
  { letter: "B", min: 70 },
  { letter: "B-", min: 65 },
  { letter: "C+", min: 60 },
  { letter: "C", min: 55 },
  { letter: "C-", min: 50 },
  { letter: "D", min: 40 },
];

export function gradeBands(): GradeBand[] {
  const raw = getSetting("grade_bands");
  if (!raw) return DEFAULT_BANDS;
  try {
    const parsed = JSON.parse(raw) as GradeBand[];
    const clean = parsed
      .filter((b) => b && typeof b.letter === "string" && Number.isFinite(b.min))
      .sort((a, b) => b.min - a.min);
    return clean.length ? clean : DEFAULT_BANDS;
  } catch {
    return DEFAULT_BANDS;
  }
}

export type AssessmentRow = {
  id: string;
  course_id: string | null;
  assignment_id: string | null;
  group_id: string | null;
  title: string;
  weight: number | null;
  score: number | null;
  max_score: number | null;
  due_at: string | null;
  is_final: number;
  is_bonus: number;
  min_percent: number | null;
  source: string;
};

export type GroupRow = {
  id: string;
  course_id: string | null;
  name: string;
  weight: number | null;
  drop_lowest: number;
};

/** An assessment plus everything the calculator worked out about it. */
export interface ResolvedAssessment extends AssessmentRow {
  /** Weight actually applied — for a grouped item, its share of the group. */
  effectiveWeight: number;
  /** Percent achieved, or null when unmarked. */
  percent: number | null;
  /** True when this result is discarded by its group's drop-lowest rule. */
  dropped: boolean;
  /** True when marked and below its own hurdle. */
  belowHurdle: boolean;
  groupName: string | null;
}

export interface ResolvedGroup extends GroupRow {
  items: number;
  /** Members whose results actually count, after drops. */
  counting: number;
  /** Weight each counting member carries. */
  perItemWeight: number;
  scored: number;
}

export interface BandOutcome {
  letter: string;
  min: number;
  /** Uniform % needed on every remaining assessment. */
  neededAcrossRemaining: number | null;
  /** % needed on the solved-for item, with other remaining items at `assume`. */
  neededOnFinal: number | null;
  /** True when the band is locked in even with zero on everything left. */
  secured: boolean;
  /** True when it can't be reached even with 100% on everything left. */
  impossible: boolean;
  /**
   * Set when a hurdle on the solved-for item, not the arithmetic, sets the
   * floor — "you only need 12% for a B, but you must clear 40% to pass at all".
   */
  hurdleBinds: boolean;
}

export interface CourseGrades {
  course_id: string;
  code: string | null;
  name: string;
  assessments: ResolvedAssessment[];
  groups: ResolvedGroup[];
  /** Weights in play, excluding bonus items — flags a course that isn't 100. */
  weightTotal: number;
  /** Weight of assessments that already have a counting mark. */
  gradedWeight: number;
  /** Weight still to be earned. */
  remainingWeight: number;
  /** Grade points banked out of 100 (including any bonus already earned). */
  earnedPoints: number;
  /** Points from bonus/extra-credit items, on top of the 100. */
  bonusPoints: number;
  /** Your average across what's been marked, as a percentage. */
  markSoFar: number | null;
  /** Best possible final grade if everything left is perfect. */
  ceiling: number;
  /** Where you'd land if everything left scores like your current average. */
  projected: number | null;
  /** The item the calculator solves for. */
  final: { id: string; title: string; weight: number; minPercent: number | null } | null;
  /** Weight of unmarked work that ISN'T the solved-for item. */
  otherRemainingWeight: number;
  /** What that other remaining work is assumed to score. */
  assume: number | null;
  bands: BandOutcome[];
  currentLetter: string | null;
  projectedLetter: string | null;
  /** Hurdles already missed, and hurdles still ahead — neither is arithmetic. */
  hurdlesMissed: { title: string; percent: number; required: number }[];
  /** True when a group's drops can't be settled yet, so figures are estimates. */
  dropsProvisional: boolean;
}

/** Percent achieved on one assessment, or null when it isn't marked yet. */
function percentOf(a: AssessmentRow): number | null {
  if (a.score == null) return null;
  const max = a.max_score && a.max_score > 0 ? a.max_score : 100;
  return (a.score / max) * 100;
}

/**
 * Work out what each item is actually worth.
 *
 * Ungrouped items use their own weight. Grouped items split the group's weight
 * between the members that count — so "Labs, 20%, best 8 of 10" needs one number
 * entered once, and stays correct when an eleventh lab appears. An explicit
 * per-item weight inside a group still wins, for the group that's 20% split
 * unevenly.
 *
 * Which results get dropped can't be known until everything is marked, so
 * unmarked members are assumed to survive and the worst *marked* ones fill the
 * remaining slots. That's the optimistic reading, which is the point of a
 * drop-lowest rule, and it self-corrects as marks arrive.
 */
function resolve(
  rows: AssessmentRow[],
  groups: GroupRow[],
): { assessments: ResolvedAssessment[]; groups: ResolvedGroup[]; provisional: boolean } {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const dropped = new Set<string>();
  const perItem = new Map<string, number>();
  const resolvedGroups: ResolvedGroup[] = [];
  let provisional = false;

  for (const g of groups) {
    const members = rows.filter((r) => r.group_id === g.id);
    const explicit = members.filter((m) => m.weight != null);
    const implicit = members.filter((m) => m.weight == null);
    const groupWeight = g.weight ?? 0;
    const drop = Math.max(0, Math.min(g.drop_lowest, Math.max(0, members.length - 1)));
    const counting = Math.max(0, members.length - drop);

    /**
     * Exactly `drop` members have to be excluded, however many are marked — the
     * group is only ever worth its stated weight, and each counting member has
     * to carry weight/counting for that to hold ("best 8 of 10" at 20% means
     * 2.5% a lab, not 2%).
     *
     * Marked results are excluded worst-first, but unmarked ones hold their slot
     * ahead of a marked one: an attempt you haven't sat yet is assumed to beat
     * your worst, which is the optimistic reading a drop-lowest rule invites.
     * Any shortfall is made up from the trailing unmarked members — arbitrary,
     * but they contribute nothing either way, and it keeps the slot count honest.
     */
    if (drop > 0) {
      const marked = members
        .filter((m) => m.score != null)
        .sort((a, b) => (percentOf(b) ?? 0) - (percentOf(a) ?? 0));
      const unmarked = members.filter((m) => m.score == null);
      if (unmarked.length > 0) provisional = true;

      const markedSlots = Math.max(0, counting - unmarked.length);
      const excludedMarked = marked.slice(markedSlots);
      for (const m of excludedMarked) dropped.add(m.id);

      const shortfall = drop - excludedMarked.length;
      if (shortfall > 0) {
        for (const m of unmarked.slice(unmarked.length - shortfall)) dropped.add(m.id);
      }
    }

    // The group weight is shared between counting members that don't set their
    // own weight; explicitly weighted members take their stated share first.
    const explicitTotal = explicit
      .filter((m) => !dropped.has(m.id))
      .reduce((s, m) => s + (m.weight ?? 0), 0);
    const countingImplicit = implicit.filter((m) => !dropped.has(m.id)).length;
    const share =
      countingImplicit > 0 ? Math.max(0, groupWeight - explicitTotal) / countingImplicit : 0;

    for (const m of members) {
      perItem.set(m.id, dropped.has(m.id) ? 0 : (m.weight ?? share));
    }

    resolvedGroups.push({
      ...g,
      items: members.length,
      counting,
      perItemWeight: round2(share),
      scored: members.filter((m) => m.score != null).length,
    });
  }

  const assessments: ResolvedAssessment[] = rows.map((r) => {
    const percent = percentOf(r);
    const effectiveWeight = r.group_id ? (perItem.get(r.id) ?? 0) : (r.weight ?? 0);
    return {
      ...r,
      effectiveWeight: round2(effectiveWeight),
      percent: percent == null ? null : round1(percent),
      dropped: dropped.has(r.id),
      belowHurdle: percent != null && r.min_percent != null && percent < r.min_percent,
      groupName: r.group_id ? (byId.get(r.group_id)?.name ?? null) : null,
    };
  });

  return { assessments, groups: resolvedGroups, provisional };
}

export function letterFor(percent: number, bands = gradeBands()): string | null {
  for (const b of bands) if (percent >= b.min) return b.letter;
  return null;
}

/**
 * Work out the grade picture for one course.
 *
 * `assume` is the score the *other* unmarked assessments are expected to get
 * when solving for the final — it defaults to your current average, because
 * "what do I need on the final" is meaningless if a 40%-worth of coursework
 * still outstanding is silently treated as a zero.
 */
export function computeCourse(
  course: { id: string; code: string | null; name: string },
  rows: AssessmentRow[],
  groupRows: GroupRow[] = [],
  opts: { assume?: number | null } = {},
): CourseGrades {
  const bands = gradeBands();
  const { assessments, groups, provisional } = resolve(rows, groupRows);

  // Bonus items sit outside the 100: they add points without diluting anything.
  const counted = assessments.filter((a) => a.effectiveWeight > 0 && !a.is_bonus && !a.dropped);
  const bonus = assessments.filter((a) => a.is_bonus && a.effectiveWeight > 0 && !a.dropped);

  let earnedPoints = 0;
  let gradedWeight = 0;
  let gradedPercentSum = 0;
  for (const a of counted) {
    if (a.percent == null) continue;
    gradedWeight += a.effectiveWeight;
    earnedPoints += (a.effectiveWeight * a.percent) / 100;
    gradedPercentSum += a.percent * a.effectiveWeight;
  }

  let bonusPoints = 0;
  for (const a of bonus) {
    if (a.percent == null) continue;
    bonusPoints += (a.effectiveWeight * a.percent) / 100;
  }

  const weightTotal = round2(counted.reduce((s, a) => s + a.effectiveWeight, 0));
  const remainingWeight = round2(Math.max(0, weightTotal - gradedWeight));
  const markSoFar = gradedWeight > 0 ? round2(gradedPercentSum / gradedWeight) : null;
  const assume = opts.assume ?? markSoFar;

  // The item being solved for: whatever's flagged, else the heaviest unmarked
  // item — which is the exam in almost every course, and a better guess than
  // giving up and showing nothing.
  const unmarked = counted.filter((a) => a.percent == null);
  const finalRow =
    unmarked.find((a) => a.is_final === 1) ??
    [...unmarked].sort((a, b) => b.effectiveWeight - a.effectiveWeight)[0] ??
    null;
  const finalWeight = finalRow?.effectiveWeight ?? 0;
  const otherRemainingWeight = round2(Math.max(0, remainingWeight - finalWeight));

  const ceiling = round2(earnedPoints + remainingWeight + bonusUpside(bonus));
  const projected =
    markSoFar == null
      ? null
      : round2(earnedPoints + bonusPoints + (remainingWeight * markSoFar) / 100);

  const banked = earnedPoints + bonusPoints;

  const outcomes: BandOutcome[] = bands.map((b) => {
    const gap = b.min - banked;
    const secured = banked >= b.min;
    const impossible = ceiling < b.min;

    const neededAcrossRemaining =
      secured || impossible || remainingWeight <= 0 ? null : round1((gap / remainingWeight) * 100);

    let neededOnFinal: number | null = null;
    let hurdleBinds = false;
    if (!secured && !impossible && finalRow && finalWeight > 0) {
      const fromOthers = assume == null ? 0 : (otherRemainingWeight * assume) / 100;
      const arithmetic = ((gap - fromOthers) / finalWeight) * 100;
      const hurdle = finalRow.min_percent ?? 0;
      // A hurdle you must clear regardless outranks the arithmetic: needing 12%
      // for a B is irrelevant if the course also demands 40% on the exam.
      hurdleBinds = hurdle > arithmetic;
      neededOnFinal = round1(Math.max(arithmetic, hurdle));
    }

    return {
      letter: b.letter,
      min: b.min,
      neededAcrossRemaining,
      neededOnFinal,
      secured,
      impossible,
      hurdleBinds,
    };
  });

  const hurdlesMissed = assessments
    .filter((a) => a.belowHurdle && !a.dropped)
    .map((a) => ({ title: a.title, percent: a.percent!, required: a.min_percent! }));

  return {
    course_id: course.id,
    code: course.code,
    name: course.name,
    assessments,
    groups,
    weightTotal,
    gradedWeight: round2(gradedWeight),
    remainingWeight,
    earnedPoints: round2(banked),
    bonusPoints: round2(bonusPoints),
    markSoFar,
    ceiling,
    projected,
    final: finalRow
      ? {
          id: finalRow.id,
          title: finalRow.title,
          weight: finalWeight,
          minPercent: finalRow.min_percent,
        }
      : null,
    otherRemainingWeight,
    assume: assume == null ? null : round1(assume),
    bands: outcomes,
    currentLetter: markSoFar == null ? null : letterFor(markSoFar, bands),
    projectedLetter: projected == null ? null : letterFor(projected, bands),
    hurdlesMissed,
    dropsProvisional: provisional,
  };
}

/** Points still available from unmarked bonus items. */
function bonusUpside(bonus: ResolvedAssessment[]): number {
  return bonus.reduce(
    (s, a) => s + (a.percent == null ? a.effectiveWeight : (a.effectiveWeight * a.percent) / 100),
    0,
  );
}

const SELECT_ASSESSMENTS = `SELECT id, course_id, assignment_id, group_id, title, weight, score,
    max_score, due_at, is_final, is_bonus, min_percent, source
  FROM assessments WHERE course_id = ? ORDER BY due_at IS NULL, due_at, title`;

/** Grade picture for every active course (or one). */
export function courseGrades(courseId?: string): CourseGrades[] {
  const db = getDb();
  const courses = (
    courseId
      ? db.prepare("SELECT id, code, name FROM courses WHERE id = ?").all(courseId)
      : db.prepare("SELECT id, code, name FROM courses WHERE active = 1 ORDER BY name").all()
  ) as { id: string; code: string | null; name: string }[];

  return courses.map((c) => {
    const rows = db.prepare(SELECT_ASSESSMENTS).all(c.id) as AssessmentRow[];
    const groups = db
      .prepare(
        "SELECT id, course_id, name, weight, drop_lowest FROM assessment_groups WHERE course_id = ? ORDER BY name",
      )
      .all(c.id) as GroupRow[];
    const assumeRaw = getSetting(`grade_assume:${c.id}`);
    const assume = assumeRaw == null || assumeRaw === "" ? undefined : Number(assumeRaw);
    return computeCourse(c, rows, groups, {
      assume: Number.isFinite(assume as number) ? assume : undefined,
    });
  });
}

/**
 * Scale every weight so the course adds up to 100, preserving proportions.
 * The common case is a course outline that lists 3 of 4 items, or one entered as
 * marks (25 + 25 + 40 = 90) rather than percentages.
 */
export function normaliseWeights(courseId: string): { scaled: number; from: number } {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, weight FROM assessments WHERE course_id = ? AND is_bonus = 0 AND weight IS NOT NULL AND group_id IS NULL",
    )
    .all(courseId) as { id: string; weight: number }[];
  const groups = db
    .prepare("SELECT id, weight FROM assessment_groups WHERE course_id = ? AND weight IS NOT NULL")
    .all(courseId) as { id: string; weight: number }[];

  const total =
    rows.reduce((s, r) => s + r.weight, 0) + groups.reduce((s, g) => s + g.weight, 0);
  if (total <= 0) return { scaled: 0, from: 0 };

  const factor = 100 / total;
  // Scale, then hand the rounding residue to the heaviest item so the course
  // lands on exactly 100 — "100.03%" is its own little irritation.
  const scaled = [
    ...rows.map((r) => ({ kind: "item" as const, id: r.id, weight: round2(r.weight * factor) })),
    ...groups.map((g) => ({ kind: "group" as const, id: g.id, weight: round2(g.weight * factor) })),
  ];
  const residue = round2(100 - scaled.reduce((s, x) => s + x.weight, 0));
  if (residue !== 0 && scaled.length) {
    const biggest = scaled.reduce((a, b) => (b.weight > a.weight ? b : a));
    biggest.weight = round2(biggest.weight + residue);
  }

  const setItem = db.prepare(
    "UPDATE assessments SET weight = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const setGroup = db.prepare(
    "UPDATE assessment_groups SET weight = ?, updated_at = datetime('now') WHERE id = ?",
  );
  for (const x of scaled) (x.kind === "item" ? setItem : setGroup).run(x.weight, x.id);

  return { scaled: scaled.length, from: round2(total) };
}

/** The student's declared target for a course, e.g. "A". */
export function targetFor(courseId: string): string | null {
  return getSetting(`grade_target:${courseId}`);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
