import { getDb, upsert } from "@uni/db";
import { moodleApiConfigured, moodleWs } from "./moodle-api.js";

export interface GradesResult {
  courses: number;
  items: number;
  graded: number;
  weighted: number;
}

/**
 * Import the Moodle gradebook into `assessments` — the weights and marks the
 * grade calculator needs.
 *
 * Weightings are the whole point here, and they're the one thing students
 * otherwise have to copy out of a course outline by hand. Marks already earned
 * come along for free, so "what do I need on the final?" answers itself.
 *
 * A row the student has edited by hand is never overwritten with a blank: the
 * gradebook wins on marks, the student wins on weights the gradebook doesn't know.
 */
export async function syncGrades(courseId?: string): Promise<GradesResult> {
  const out: GradesResult = { courses: 0, items: 0, graded: 0, weighted: 0 };
  if (!moodleApiConfigured()) return out;

  const db = getDb();
  const me = await moodleWs<{ userid: number }>("core_webservice_get_site_info");
  const courses = (
    courseId
      ? db.prepare("SELECT id FROM courses WHERE id = ?").all(courseId)
      : db.prepare("SELECT id FROM courses WHERE active = 1").all()
  ) as { id: string }[];

  for (const course of courses) {
    const numId = Number(course.id.match(/moodle:course:(\d+)/)?.[1] ?? NaN);
    if (!Number.isFinite(numId)) continue;

    let items: GradeItem[] = [];
    try {
      const res = await moodleWs<{ usergrades: { gradeitems: GradeItem[] }[] }>(
        "gradereport_user_get_grade_items",
        { courseid: numId, userid: me.userid },
      );
      items = res.usergrades?.[0]?.gradeitems ?? [];
    } catch {
      continue; // gradebook closed to web services on this site
    }
    out.courses++;

    for (const item of items) {
      // 'course' and 'category' rows are subtotals, not things you sit.
      if (item.itemtype === "course" || item.itemtype === "category") continue;
      const title = (item.itemname ?? "").trim();
      if (!title) continue;

      const id = `moodle:gradeitem:${item.id}`;
      const weight = parseWeight(item);
      const score = typeof item.graderaw === "number" ? item.graderaw : null;
      const max = typeof item.grademax === "number" ? item.grademax : null;
      const existing = db
        .prepare("SELECT weight, is_final, due_at FROM assessments WHERE id = ?")
        .get(id) as { weight: number | null; is_final: number; due_at: string | null } | undefined;

      if (score != null) out.graded++;
      if (weight != null) out.weighted++;
      out.items++;

      upsert(
        "assessments",
        {
          id,
          course_id: course.id,
          assignment_id: item.cmid ? findAssignment(item.cmid) : null,
          title,
          // Never clobber a weight the student typed with a null from Moodle.
          weight: weight ?? existing?.weight ?? null,
          score,
          max_score: max ?? 100,
          due_at: existing?.due_at ?? dueFromAssignment(item.cmid),
          is_final: existing?.is_final ?? (looksFinal(title) ? 1 : 0),
          source: "gradebook",
        },
        [
          "course_id", "assignment_id", "title", "weight", "score",
          "max_score", "due_at", "is_final", "source",
        ],
      );
    }
  }

  seedFromAssignments();
  return out;
}

/**
 * Courses whose gradebook is closed still have assignments with due dates —
 * list those as unweighted rows so the student can type the weights in rather
 * than starting from an empty table.
 */
function seedFromAssignments(): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.course_id, a.title, a.due_at FROM assignments a
       JOIN courses c ON c.id = a.course_id
       WHERE c.active = 1
         AND NOT EXISTS (SELECT 1 FROM assessments s WHERE s.assignment_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM assessments s WHERE s.course_id = a.course_id AND lower(s.title) = lower(a.title))`,
    )
    .all() as { id: string; course_id: string; title: string; due_at: string | null }[];

  for (const a of rows) {
    upsert(
      "assessments",
      {
        id: `assign-grade:${a.id}`,
        course_id: a.course_id,
        assignment_id: a.id,
        title: a.title,
        weight: null,
        score: null,
        max_score: 100,
        due_at: a.due_at,
        is_final: looksFinal(a.title) ? 1 : 0,
        source: "assignment",
      },
      ["course_id", "assignment_id", "title", "max_score", "due_at", "is_final", "source"],
    );
  }
}

/**
 * Moodle reports weight two ways and sites disagree on which is populated:
 * `weightformatted` ("25.00 %") when the gradebook shows weights, else the raw
 * aggregation coefficient (0.25, or already 25 on some setups).
 */
function parseWeight(item: GradeItem): number | null {
  const formatted = item.weightformatted?.match(/([\d.]+)\s*%/);
  if (formatted) {
    const n = Number(formatted[1]);
    if (Number.isFinite(n) && n > 0) return round2(n);
  }
  if (typeof item.weightraw === "number" && item.weightraw > 0) {
    return round2(item.weightraw <= 1 ? item.weightraw * 100 : item.weightraw);
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Exams and finals are what the calculator solves for, so flag them on sight. */
function looksFinal(title: string): boolean {
  return /\b(final|exam|examination)\b/i.test(title) && !/practice|mock|past/i.test(title);
}

function findAssignment(cmid: number): string | null {
  const row = getDb()
    .prepare("SELECT id FROM assignments WHERE url LIKE ?")
    .get(`%id=${cmid}%`) as { id: string } | undefined;
  return row?.id ?? null;
}

function dueFromAssignment(cmid: number | undefined): string | null {
  if (!cmid) return null;
  const id = findAssignment(cmid);
  if (!id) return null;
  const row = getDb().prepare("SELECT due_at FROM assignments WHERE id = ?").get(id) as
    | { due_at: string | null }
    | undefined;
  return row?.due_at ?? null;
}

interface GradeItem {
  id: number;
  itemname?: string;
  itemtype?: string;
  itemmodule?: string;
  cmid?: number;
  graderaw?: number | null;
  grademax?: number | null;
  weightraw?: number | null;
  weightformatted?: string | null;
}
