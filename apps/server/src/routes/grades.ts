import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getDb, getSetting, setSetting } from "@uni/db";
import { syncGrades } from "@uni/lms";
import {
  courseGrades,
  gradeBands,
  normaliseWeights,
  DEFAULT_BANDS,
  type GradeBand,
} from "../grades.js";
import { parseOutline } from "../outline.js";
import { readOutline } from "../outline-read.js";

interface AssessmentBody {
  course_id?: string;
  group_id?: string | null;
  title?: string;
  weight?: number | null;
  score?: number | null;
  max_score?: number | null;
  due_at?: string | null;
  is_final?: boolean;
  is_bonus?: boolean;
  min_percent?: number | null;
}

interface GroupBody {
  course_id?: string;
  name?: string;
  weight?: number | null;
  drop_lowest?: number;
  /** Create this many members up front, named "<name> 1..n". */
  count?: number;
}

export async function registerGradesRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /** Everything the Grades page renders: per-course maths, bands and targets. */
  app.get<{ Querystring: { course_id?: string } }>("/api/grades", async (req) => {
    const courses = courseGrades(req.query.course_id);
    const targets: Record<string, string> = {};
    for (const c of courses) {
      const t = getSetting(`grade_target:${c.course_id}`);
      if (t) targets[c.course_id] = t;
    }
    return { bands: gradeBands(), courses, targets };
  });

  /** Pull weights + marks from the Moodle gradebook. */
  app.post<{ Body: { course_id?: string } }>("/api/grades/sync", async (req, reply) => {
    try {
      return { ok: true, ...(await syncGrades(req.body?.course_id)) };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    }
  });

  app.post<{ Body: AssessmentBody }>("/api/assessments", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.course_id) return reply.code(400).send({ error: "course_id is required." });
    const id = insertAssessment(b.course_id, b);
    return db.prepare("SELECT * FROM assessments WHERE id = ?").get(id);
  });

  /** Partial update — the Grades table edits one cell at a time. */
  app.put<{ Params: { id: string }; Body: AssessmentBody }>(
    "/api/assessments/:id",
    async (req, reply) => {
      const existing = db.prepare("SELECT * FROM assessments WHERE id = ?").get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!existing) return reply.code(404).send({ error: "not found" });
      const b = req.body ?? {};

      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      const set = (col: string, v: string | number | null) => {
        sets.push(`${col} = ?`);
        vals.push(v);
      };
      if (b.title !== undefined) set("title", b.title.trim() || "Untitled assessment");
      if (b.weight !== undefined) set("weight", num(b.weight));
      if (b.score !== undefined) set("score", num(b.score));
      if (b.max_score !== undefined) set("max_score", num(b.max_score) ?? 100);
      if (b.due_at !== undefined) set("due_at", b.due_at || null);
      if (b.group_id !== undefined) set("group_id", b.group_id || null);
      if (b.is_bonus !== undefined) set("is_bonus", b.is_bonus ? 1 : 0);
      if (b.min_percent !== undefined) set("min_percent", num(b.min_percent));
      if (b.is_final !== undefined) {
        set("is_final", b.is_final ? 1 : 0);
        // Only one item can be "the final" per course, or the solve is ambiguous.
        if (b.is_final) {
          db.prepare("UPDATE assessments SET is_final = 0 WHERE course_id = ? AND id <> ?").run(
            existing.course_id as string,
            req.params.id,
          );
        }
      }
      if (!sets.length) return existing;
      vals.push(req.params.id);
      db.prepare(
        `UPDATE assessments SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`,
      ).run(...vals);
      return db.prepare("SELECT * FROM assessments WHERE id = ?").get(req.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/assessments/:id", async (req) => {
    db.prepare("DELETE FROM assessments WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  /** The grade you're aiming for, per course — drives the highlighted row. */
  app.put<{ Body: { course_id: string; letter: string | null } }>(
    "/api/grades/target",
    async (req) => {
      setSetting(`grade_target:${req.body.course_id}`, req.body.letter ?? "");
      return { ok: true };
    },
  );

  /**
   * What to assume the *other* unmarked assessments will score when solving for
   * the final. Blank means "same as my current average".
   */
  app.put<{ Body: { course_id: string; assume: number | null } }>(
    "/api/grades/assume",
    async (req) => {
      const v = num(req.body.assume);
      setSetting(`grade_assume:${req.body.course_id}`, v == null ? "" : String(v));
      return { ok: true };
    },
  );

  /* --- Weighted bundles: "Labs 20% total, best 8 of 10" ------------------- */

  app.post<{ Body: GroupBody }>("/api/assessment-groups", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.course_id) return reply.code(400).send({ error: "course_id is required." });
    const name = (b.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "Give the group a name, e.g. “Labs”." });

    const id = randomUUID();
    const count = Math.min(40, Math.max(0, Math.round(Number(b.count) || 0)));
    db.prepare(
      "INSERT INTO assessment_groups (id, course_id, name, weight, drop_lowest) VALUES (?,?,?,?,?)",
    ).run(id, b.course_id, name, num(b.weight), clampDrop(b.drop_lowest, count));

    // Members are created up front so the weight-per-item is meaningful straight
    // away — an empty group divides its weight by nothing.
    for (let i = 1; i <= count; i++) {
      insertAssessment(b.course_id, { title: `${singular(name)} ${i}`, group_id: id });
    }
    return db.prepare("SELECT * FROM assessment_groups WHERE id = ?").get(id);
  });

  app.put<{ Params: { id: string }; Body: GroupBody }>(
    "/api/assessment-groups/:id",
    async (req, reply) => {
      const existing = db.prepare("SELECT * FROM assessment_groups WHERE id = ?").get(req.params.id) as
        | { name: string; weight: number | null; drop_lowest: number }
        | undefined;
      if (!existing) return reply.code(404).send({ error: "not found" });
      const b = req.body ?? {};
      const members = (
        db.prepare("SELECT COUNT(*) AS n FROM assessments WHERE group_id = ?").get(req.params.id) as {
          n: number;
        }
      ).n;

      db.prepare(
        "UPDATE assessment_groups SET name = ?, weight = ?, drop_lowest = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(
        (b.name ?? existing.name).trim() || existing.name,
        b.weight !== undefined ? num(b.weight) : existing.weight,
        b.drop_lowest !== undefined ? clampDrop(b.drop_lowest, members) : existing.drop_lowest,
        req.params.id,
      );
      return db.prepare("SELECT * FROM assessment_groups WHERE id = ?").get(req.params.id);
    },
  );

  /** Deleting a group leaves its members behind, unweighted, rather than
   *  silently destroying marks the student typed in. */
  app.delete<{ Params: { id: string }; Querystring: { items?: string } }>(
    "/api/assessment-groups/:id",
    async (req) => {
      if (req.query.items === "delete") {
        db.prepare("DELETE FROM assessments WHERE group_id = ?").run(req.params.id);
      }
      db.prepare("DELETE FROM assessment_groups WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );

  /** Add one more member to a group — "we got an eleventh lab". */
  app.post<{ Params: { id: string } }>("/api/assessment-groups/:id/items", async (req, reply) => {
    const g = db.prepare("SELECT course_id, name FROM assessment_groups WHERE id = ?").get(
      req.params.id,
    ) as { course_id: string; name: string } | undefined;
    if (!g) return reply.code(404).send({ error: "not found" });
    const n =
      (db.prepare("SELECT COUNT(*) AS n FROM assessments WHERE group_id = ?").get(req.params.id) as {
        n: number;
      }).n + 1;
    const id = insertAssessment(g.course_id, {
      title: `${singular(g.name)} ${n}`,
      group_id: req.params.id,
    });
    return db.prepare("SELECT * FROM assessments WHERE id = ?").get(id);
  });

  /* --- Bulk entry --------------------------------------------------------- */

  /** Scale existing weights to sum to 100, keeping their proportions. */
  app.post<{ Body: { course_id?: string } }>("/api/grades/normalise", async (req, reply) => {
    if (!req.body?.course_id) return reply.code(400).send({ error: "course_id is required." });
    const r = normaliseWeights(req.body.course_id);
    if (!r.scaled) return reply.code(400).send({ error: "No weights to scale yet." });
    return { ok: true, ...r };
  });

  /** Preview a pasted assessment schedule without saving anything. */
  app.post<{ Body: { text?: string } }>("/api/grades/parse-outline", async (req) => {
    return parseOutline(req.body?.text ?? "");
  });

  /**
   * Read the schedule out of the course outline PDF the file sync already
   * downloaded, rather than asking the student to find and paste it. Returns a
   * proposal — a wrong weighting quietly corrupts every prediction afterwards, so
   * it is never applied without being seen.
   */
  app.post<{ Body: { course_id?: string } }>("/api/grades/read-outline", async (req, reply) => {
    const courseId = req.body?.course_id;
    if (!courseId) return reply.code(400).send({ error: "course_id is required." });
    try {
      const read = await readOutline(courseId);
      if (!read) {
        return reply.code(404).send({
          error:
            "No course outline found among this course's downloaded files. Sync course files, or paste the schedule below.",
        });
      }
      return { ok: true, ...read };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Every active course that still has no weightings — the first-run case. */
  app.post("/api/grades/read-outline/all", async () => {
    const courses = db
      .prepare(
        `SELECT c.id, c.code FROM courses c
          WHERE c.active = 1
            AND NOT EXISTS (
              SELECT 1 FROM assessments a WHERE a.course_id = c.id AND a.weight IS NOT NULL
            )
          ORDER BY c.code`,
      )
      .all() as { id: string; code: string | null }[];

    const reads = [];
    const failed: { code: string | null; error: string }[] = [];
    for (const c of courses) {
      try {
        const read = await readOutline(c.id);
        if (read) reads.push(read);
        else failed.push({ code: c.code, error: "no outline found among the downloaded files" });
      } catch (e) {
        failed.push({ code: c.code, error: String(e instanceof Error ? e.message : e) });
      }
    }
    return { ok: true, reads, failed };
  });

  /**
   * Save a parsed schedule. `replace` clears existing weights first — the usual
   * case, since this is how a course gets set up — but marks already entered on
   * matching titles are carried across so nobody loses their results.
   */
  app.post<{
    Body: {
      course_id?: string;
      items?: {
        title: string;
        weight: number;
        isFinal?: boolean;
        isBonus?: boolean;
        minPercent?: number | null;
        dueAt?: string | null;
        group?: { count: number; dropLowest: number } | null;
      }[];
      replace?: boolean;
    };
  }>("/api/grades/import-outline", async (req, reply) => {
    const courseId = req.body?.course_id;
    const items = req.body?.items ?? [];
    if (!courseId) return reply.code(400).send({ error: "course_id is required." });
    if (!items.length) return reply.code(400).send({ error: "Nothing to import." });

    // Keep any marks the student already typed, matched on title.
    const priorMarks = new Map<string, { score: number | null; max_score: number | null }>();
    for (const row of db
      .prepare("SELECT title, score, max_score FROM assessments WHERE course_id = ? AND score IS NOT NULL")
      .all(courseId) as { title: string; score: number; max_score: number | null }[]) {
      priorMarks.set(norm(row.title), { score: row.score, max_score: row.max_score });
    }

    if (req.body?.replace) {
      db.prepare("DELETE FROM assessments WHERE course_id = ?").run(courseId);
      db.prepare("DELETE FROM assessment_groups WHERE course_id = ?").run(courseId);
    }

    let created = 0;
    let groups = 0;
    for (const item of items) {
      const title = (item.title ?? "").trim();
      if (!title || !Number.isFinite(item.weight)) continue;

      if (item.group && item.group.count > 1) {
        const gid = randomUUID();
        db.prepare(
          "INSERT INTO assessment_groups (id, course_id, name, weight, drop_lowest) VALUES (?,?,?,?,?)",
        ).run(gid, courseId, title, item.weight, clampDrop(item.group.dropLowest, item.group.count));
        groups++;
        for (let i = 1; i <= item.group.count; i++) {
          const memberTitle = `${singular(title)} ${i}`;
          insertAssessment(courseId, {
            title: memberTitle,
            group_id: gid,
            ...(priorMarks.get(norm(memberTitle)) ?? {}),
          });
          created++;
        }
        continue;
      }

      insertAssessment(courseId, {
        title,
        weight: item.weight,
        // A stated exam or test date is the thing everything else is planned
        // around, so it comes through with the weighting rather than separately.
        due_at: item.dueAt ?? null,
        is_final: item.isFinal === true,
        is_bonus: item.isBonus === true,
        min_percent: item.minPercent ?? null,
        ...(priorMarks.get(norm(title)) ?? {}),
      });
      created++;
    }

    // Only one solve-for target per course.
    const finals = db
      .prepare("SELECT id FROM assessments WHERE course_id = ? AND is_final = 1")
      .all(courseId) as { id: string }[];
    if (finals.length > 1) {
      db.prepare("UPDATE assessments SET is_final = 0 WHERE course_id = ? AND id <> ?").run(
        courseId,
        finals[0]!.id,
      );
    }

    return { ok: true, created, groups };
  });

  app.get("/api/grades/bands", async () => ({ bands: gradeBands(), defaults: DEFAULT_BANDS }));

  app.put<{ Body: { bands: GradeBand[] } }>("/api/grades/bands", async (req, reply) => {
    const bands = (req.body?.bands ?? []).filter(
      (b) => b && typeof b.letter === "string" && Number.isFinite(Number(b.min)),
    );
    if (!bands.length) return reply.code(400).send({ error: "Provide at least one grade band." });
    setSetting(
      "grade_bands",
      JSON.stringify(bands.map((b) => ({ letter: b.letter.trim(), min: Number(b.min) }))),
    );
    return { ok: true, bands: gradeBands() };
  });

  /** One insert path for every way an assessment gets created. */
  function insertAssessment(
    courseId: string,
    fields: {
      title?: string;
      group_id?: string | null;
      weight?: number | null;
      score?: number | null;
      max_score?: number | null;
      due_at?: string | null;
      is_final?: boolean;
      is_bonus?: boolean;
      min_percent?: number | null;
    },
  ): string {
    const id = `manual:${randomUUID()}`;
    db.prepare(
      `INSERT INTO assessments
         (id, course_id, group_id, title, weight, score, max_score, due_at, is_final, is_bonus, min_percent, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'manual')`,
    ).run(
      id,
      courseId,
      fields.group_id ?? null,
      fields.title?.trim() || "Untitled assessment",
      num(fields.weight),
      num(fields.score),
      num(fields.max_score) ?? 100,
      fields.due_at ?? null,
      fields.is_final ? 1 : 0,
      fields.is_bonus ? 1 : 0,
      num(fields.min_percent),
    );
    return id;
  }
}

/** Empty string / null / NaN all mean "not set", not zero. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** You can never drop every member — that would zero the group's weight. */
function clampDrop(value: unknown, members: number): number {
  const n = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(n, Math.max(0, members - 1)));
}

/** "Labs" → "Lab", so members read "Lab 1" not "Labs 1". */
function singular(name: string): string {
  if (/(ses|zes|ches|shes|xes)$/i.test(name)) return name.slice(0, -2);
  if (/ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  if (/[^s]s$/i.test(name)) return name.slice(0, -1);
  return name;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
