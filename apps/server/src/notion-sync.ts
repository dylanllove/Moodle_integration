import { randomUUID } from "node:crypto";
import { getDb, setSetting } from "@uni/db";
import { notion, weightFromNotion, weightToNotion, type FieldMap } from "./notion.js";
import {
  ensureUniIdColumn,
  linkFor,
  listLinks,
  readSchema,
  stampLink,
  type LinkedSchema,
  type NotionLink,
} from "./notion-links.js";
import { courseGrades } from "./grades.js";
import { markdownToBlocks, blocksToMarkdown } from "./notion-blocks.js";

/**
 * Moving data between the platform and Notion, in both directions.
 *
 * Push and pull are deliberately asymmetric about authority. Notion is where the
 * student types, so a value they entered there wins: pulling overwrites our copy,
 * and pushing never blanks a field Notion has filled in. Anything we generate —
 * a transcript's study notes, a deadline scraped from Moodle — is ours, and push
 * is the authority on that.
 */

export interface SyncCounts {
  created: number;
  updated: number;
  archived: number;
  pulled: number;
  skipped: number;
}

const zero = (): SyncCounts => ({ created: 0, updated: 0, archived: 0, pulled: 0, skipped: 0 });
const add = (a: SyncCounts, b: SyncCounts): SyncCounts => ({
  created: a.created + b.created,
  updated: a.updated + b.updated,
  archived: a.archived + b.archived,
  pulled: a.pulled + b.pulled,
  skipped: a.skipped + b.skipped,
});

export interface NotionSyncResult extends SyncCounts {
  perLink: { title: string | null; kind: string; courseCode: string | null; counts: SyncCounts }[];
}

const text = (s: string) => [{ type: "text", text: { content: s.slice(0, 2000) } }];
const plain = (rich: any): string =>
  (Array.isArray(rich) ? rich : []).map((t: any) => t?.plain_text ?? "").join("");

/* --- Everything, both ways ------------------------------------------------- */

export async function syncNotion(): Promise<NotionSyncResult> {
  const out: NotionSyncResult = { ...zero(), perLink: [] };
  const codes = courseCodes();

  for (const link of listLinks()) {
    const schema = await readSchema(link.notion_id).catch(() => null);
    if (!schema) {
      out.skipped++;
      continue;
    }
    let counts = zero();
    try {
      // Pull first: a weighting the student typed in Notion should be in hand
      // before we push anything derived from it.
      if (link.direction !== "push") {
        counts = add(counts, await pullLink(link, schema));
        stampLink(link.id, "last_pull");
      }
      if (link.direction !== "pull") {
        counts = add(counts, await pushLink(link, schema));
        stampLink(link.id, "last_push");
      }
    } catch (e) {
      counts.skipped++;
      throw Object.assign(e as Error, { link: link.title });
    }
    out.perLink.push({
      title: link.title,
      kind: link.kind,
      courseCode: link.course_id ? (codes.get(link.course_id) ?? null) : null,
      counts,
    });
    Object.assign(out, add(out, counts), { perLink: out.perLink });
  }

  setSetting("notion_last_push", new Date().toISOString());
  return out;
}

/** Back-compat: the old one-way entry point the scheduler and routes call. */
export async function pushToNotion(): Promise<NotionSyncResult> {
  return syncNotion();
}

function courseCodes(): Map<string, string> {
  const rows = getDb().prepare("SELECT id, code FROM courses").all() as {
    id: string;
    code: string | null;
  }[];
  return new Map(rows.filter((r) => r.code).map((r) => [r.id, r.code!]));
}

/* --- Rows already there ---------------------------------------------------- */

interface ExistingRow {
  pageId: string;
  uniId: string;
  props: Record<string, any>;
}

async function allRows(databaseId: string, uniIdProp: string | null): Promise<ExistingRow[]> {
  const rows: ExistingRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion<{
      results: { id: string; properties: Record<string, any> }[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/databases/${databaseId}/query`, {
      method: "POST",
      body: { page_size: 100, start_cursor: cursor },
    });
    for (const row of page.results) {
      // Notion's query returns archived rows; patching one fails outright, so
      // they're dropped here rather than at every call site.
      if ((row as any).archived === true || (row as any).in_trash === true) continue;
      rows.push({
        pageId: row.id,
        uniId: uniIdProp ? plain(row.properties?.[uniIdProp]?.rich_text) : "",
        props: row.properties ?? {},
      });
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return rows;
}

/* --- Push ------------------------------------------------------------------ */

async function pushLink(link: NotionLink, schema: LinkedSchema): Promise<SyncCounts> {
  const uniIdProp = await ensureUniIdColumn(link.notion_id, schema.fields);
  const fields = { ...schema.fields, uniId: uniIdProp };
  return link.kind === "assessments"
    ? pushAssessments(link, schema, fields, uniIdProp)
    : pushNotes(link, schema, fields, uniIdProp);
}

async function pushAssessments(
  link: NotionLink,
  schema: LinkedSchema,
  fields: FieldMap,
  uniIdProp: string,
): Promise<SyncCounts> {
  const out = zero();
  if (!fields.title) return out;

  const existing = await allRows(link.notion_id, uniIdProp);
  const pushed = new Set<string>();

  // Two live rows carrying the same stamp means an earlier sync went wrong.
  // Keep the first and let the tidy-up below archive the rest, so a table that
  // got duplicated once heals itself instead of staying wrong forever.
  const byUniId = new Map<string, ExistingRow>();
  const duplicates: ExistingRow[] = [];
  for (const row of existing) {
    if (!row.uniId) continue;
    if (byUniId.has(row.uniId)) duplicates.push(row);
    else byUniId.set(row.uniId, row);
  }
  // A row the student typed by hand has no Uni ID; match it by name so we adopt
  // it rather than adding a duplicate beside it.
  const byName = new Map(
    existing
      .filter((r) => !r.uniId)
      .map((r) => [titleKey(plain(r.props?.[fields.title!]?.title)), r] as const),
  );

  for (const item of assessmentsToPush(link.course_id)) {
    const match = byUniId.get(item.uniId) ?? byName.get(titleKey(item.title));
    const props = assessmentProps(item, fields, schema.numberFormats, uniIdProp, match);
    if (match) {
      await notion(`/pages/${match.pageId}`, { method: "PATCH", body: { properties: props } });
      out.updated++;
    } else {
      await notion("/pages", {
        method: "POST",
        body: { parent: { database_id: link.notion_id }, properties: props },
      });
      out.created++;
    }
    pushed.add(item.uniId);
  }

  // Tidy up after ourselves — but only ever our own rows. A row the student
  // typed has no stamp, and archiving one of those would be us deleting their
  // work because we didn't recognise it.
  const stale = existing.filter((r) => isOurs(r.uniId) && !pushed.has(r.uniId));
  for (const row of [...duplicates.filter((r) => isOurs(r.uniId)), ...stale]) {
    await notion(`/pages/${row.pageId}`, { method: "PATCH", body: { archived: true } });
    out.archived++;
  }
  return out;
}

/** Stamps this app writes. Anything else in the column belongs to the student. */
const isOurs = (uniId: string) =>
  /^(assessment|event|lecture):/.test(uniId ?? "");

interface PushableAssessment {
  uniId: string;
  title: string;
  due: string | null;
  weight: number | null;
  score: number | null;
  maxScore: number | null;
  kind: string;
  url: string | null;
  courseCode: string | null;
}

/**
 * What to send for a course: its assessments (which carry weightings and marks)
 * plus any deadline that hasn't become one yet, so nothing on the calendar is
 * missing from Notion.
 */
function assessmentsToPush(courseId: string | null): PushableAssessment[] {
  const db = getDb();
  const codes = courseCodes();
  const out: PushableAssessment[] = [];
  const scope = courseId ? "AND a.course_id = ?" : "";
  const args = courseId ? [courseId] : [];

  for (const course of courseGrades()) {
    if (courseId && course.course_id !== courseId) continue;
    for (const a of course.assessments) {
      out.push({
        uniId: `assessment:${a.id}`,
        title: a.title,
        due: a.due_at,
        weight: a.effectiveWeight > 0 ? a.effectiveWeight : null,
        score: a.score,
        maxScore: a.max_score,
        kind: a.is_final ? "Exam" : "Assignment",
        url: null,
        courseCode: course.code,
      });
    }
  }

  // Deadlines with no matching assessment row — still worth having in Notion.
  const known = new Set(out.map((o) => titleKey(o.title)));
  const events = db
    .prepare(
      `SELECT e.id, e.title, e.kind, e.start_at, e.url, e.course_id
         FROM events e
        WHERE e.kind IN ('deadline','exam')
          AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))
          ${courseId ? "AND e.course_id = ?" : ""}
        ORDER BY e.start_at`,
    )
    .all(...(courseId ? [courseId] : [])) as {
    id: string;
    title: string;
    kind: string;
    start_at: string;
    url: string | null;
    course_id: string | null;
  }[];

  for (const e of events) {
    const clean = e.title.replace(/^(Due|Opens):\s*/i, "");
    if (known.has(titleKey(clean))) continue;
    known.add(titleKey(clean));
    out.push({
      uniId: `event:${e.id}`,
      title: clean,
      due: e.start_at,
      weight: null,
      score: null,
      maxScore: null,
      kind: e.kind === "exam" ? "Exam" : "Assignment",
      url: e.url,
      courseCode: e.course_id ? (codes.get(e.course_id) ?? null) : null,
    });
  }
  void scope;
  void args;
  return out;
}

function assessmentProps(
  item: PushableAssessment,
  fields: FieldMap,
  formats: Record<string, string>,
  uniIdProp: string,
  existing: ExistingRow | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [fields.title!]: { title: text(item.title) },
    [uniIdProp]: { rich_text: text(item.uniId) },
  };
  if (fields.due && item.due) props[fields.due] = { date: { start: item.due } };

  // Never overwrite a number the student typed with a blank. Notion is where
  // they work; our absence of a value is not a value.
  const keepIfBlank = (prop: string | null, value: number | null) => {
    if (!prop || value == null) return;
    props[prop] = { number: value };
  };
  if (fields.weight && item.weight != null) {
    props[fields.weight] = {
      number: weightToNotion(item.weight, formats[fields.weight]),
    };
  }
  keepIfBlank(fields.score, item.score);
  keepIfBlank(fields.maxScore, item.maxScore);

  if (fields.typeSelect) props[fields.typeSelect] = { select: { name: item.kind } };
  if (fields.courseSelect && item.courseCode) {
    props[fields.courseSelect] = { select: { name: item.courseCode.slice(0, 100) } };
  }
  if (fields.link && item.url) props[fields.link] = { url: item.url };

  // Leave a field alone entirely when we have nothing for it and Notion does.
  if (existing) {
    for (const [key, value] of Object.entries(props)) {
      const before = existing.props?.[key];
      if (!before) continue;
      const ours = value as any;
      const weHaveNothing =
        (ours.number === null || ours.number === undefined) &&
        (ours.date === null || ours.date === undefined) &&
        !ours.title &&
        !ours.rich_text &&
        !ours.select &&
        !ours.url;
      if (weHaveNothing) delete props[key];
    }
  }
  return props;
}

/* --- Push: lecture notes --------------------------------------------------- */

async function pushNotes(
  link: NotionLink,
  schema: LinkedSchema,
  fields: FieldMap,
  uniIdProp: string,
): Promise<SyncCounts> {
  const out = zero();
  if (!fields.title) return out;

  const existing = await allRows(link.notion_id, uniIdProp);
  const byUniId = new Map(existing.filter((r) => r.uniId).map((r) => [r.uniId, r]));
  const codes = courseCodes();

  const rows = getDb()
    .prepare(
      `SELECT l.id, l.title, l.course_id, l.recorded_at, t.summary
         FROM lectures l JOIN transcripts t ON t.lecture_id = l.id
        WHERE t.summary IS NOT NULL
          ${link.course_id ? "AND l.course_id = ?" : "AND l.course_id IN (SELECT id FROM courses WHERE active = 1)"}
        ORDER BY l.recorded_at DESC
        LIMIT 100`,
    )
    .all(...(link.course_id ? [link.course_id] : [])) as {
    id: string;
    title: string;
    course_id: string | null;
    recorded_at: string | null;
    summary: string;
  }[];

  for (const row of rows) {
    const uniId = `lecture:${row.id}`;
    const props: Record<string, unknown> = {
      [fields.title]: { title: text(row.title) },
      [uniIdProp]: { rich_text: text(uniId) },
    };
    const code = row.course_id ? codes.get(row.course_id) : null;
    if (fields.courseSelect && code) props[fields.courseSelect] = { select: { name: code.slice(0, 100) } };
    if (fields.typeSelect) props[fields.typeSelect] = { select: { name: "Lecture" } };
    if (fields.due && row.recorded_at) props[fields.due] = { date: { start: row.recorded_at } };

    const match = byUniId.get(uniId);
    if (match) {
      // The properties are ours to maintain; the page body is not re-written,
      // because that's where the student's own annotations end up.
      await notion(`/pages/${match.pageId}`, { method: "PATCH", body: { properties: props } });
      out.updated++;
    } else {
      await notion("/pages", {
        method: "POST",
        body: {
          parent: { database_id: link.notion_id },
          properties: props,
          children: markdownToBlocks(row.summary),
        },
      });
      out.created++;
    }
  }
  return out;
}

/* --- Pull ------------------------------------------------------------------ */

async function pullLink(link: NotionLink, schema: LinkedSchema): Promise<SyncCounts> {
  return link.kind === "assessments"
    ? pullAssessments(link, schema)
    : pullNotes(link, schema);
}

/**
 * Bring Notion's assessment rows into the platform.
 *
 * This is the direction that earns its keep: the grade calculator needs
 * weightings, Moodle frequently doesn't publish them, and a student who already
 * maintains a tracker in Notion has typed them all in once. Rows are matched on
 * our own stamp where present and on the title otherwise, so a table that has
 * never been pushed to still imports cleanly.
 */
async function pullAssessments(link: NotionLink, schema: LinkedSchema): Promise<SyncCounts> {
  const out = zero();
  const f = schema.fields;
  if (!f.title || !link.course_id) {
    // Without a course we can't file the assessments anywhere sensible.
    if (!link.course_id) out.skipped++;
    return out;
  }

  const db = getDb();
  const rows = await allRows(link.notion_id, f.uniId);

  const mine = db
    .prepare("SELECT id, title FROM assessments WHERE course_id = ?")
    .all(link.course_id) as { id: string; title: string }[];
  const byName = new Map(mine.map((a) => [normalise(a.title), a.id] as const));

  for (const row of rows) {
    // A row this app wrote teaches us nothing, and importing it would create a
    // second copy of the assessment it came from — which then gets pushed back,
    // and so on. Only what the student actually typed comes in.
    if (isOurs(row.uniId)) {
      const id = row.uniId.slice(row.uniId.indexOf(":") + 1);
      const mineToo = db.prepare("SELECT id FROM assessments WHERE id = ?").get(id);
      // Except its editable columns: a weighting typed onto a row we created is
      // the whole point of pulling.
      if (mineToo) {
        applyPulled(row, f, schema, id, db);
        out.pulled++;
      }
      continue;
    }
    const title = plain(row.props?.[f.title]?.title).trim();
    if (!title) continue;

    const weightRaw = f.weight ? row.props?.[f.weight]?.number : null;
    const weight =
      weightRaw != null ? weightFromNotion(weightRaw, schema.numberFormats[f.weight!]) : null;
    const score = f.score ? (row.props?.[f.score]?.number ?? null) : null;
    const maxScore = f.maxScore ? (row.props?.[f.maxScore]?.number ?? null) : null;
    const due = f.due ? (row.props?.[f.due]?.date?.start ?? null) : null;

    // Nothing worth importing — a bare title tells the calculator nothing.
    if (weight == null && score == null && due == null) continue;

    const stamped = row.uniId.startsWith("assessment:") ? row.uniId.slice("assessment:".length) : null;
    const existingId = stamped ?? byName.get(normalise(title)) ?? null;

    if (existingId) {
      // COALESCE so a column the student left blank doesn't wipe what we have.
      // Provenance is left alone: a gradebook item that gained a weighting in
      // Notion is still a gradebook item, and relabelling it "notion" would lose
      // where it came from.
      db.prepare(
        `UPDATE assessments SET
           weight = COALESCE(?, weight),
           score = COALESCE(?, score),
           max_score = COALESCE(?, max_score),
           due_at = COALESCE(?, due_at),
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(weight, score, maxScore, due, existingId);
    } else {
      db.prepare(
        `INSERT INTO assessments (id, course_id, title, weight, score, max_score, due_at, source)
         VALUES (?,?,?,?,?,?,?,'notion')`,
      ).run(randomUUID(), link.course_id, title, weight, score, maxScore ?? 100, due);
      byName.set(normalise(title), "just-added");
    }
    out.pulled++;
  }
  return out;
}

/**
 * Bring Notion pages into the platform as notes, so they're searchable and the
 * study assistant can answer from them. Content the student wrote about a course
 * is exactly what the assistant should be grounded in.
 */
async function pullNotes(link: NotionLink, schema: LinkedSchema): Promise<SyncCounts> {
  const out = zero();
  const f = schema.fields;
  if (!f.title) return out;

  const db = getDb();
  const rows = await allRows(link.notion_id, f.uniId);
  const codes = courseCodes();
  const codeToId = new Map([...codes].map(([id, code]) => [normalise(code), id] as const));

  for (const row of rows) {
    // A row we put there ourselves has nothing to teach us.
    if (row.uniId.startsWith("lecture:")) continue;
    const title = plain(row.props?.[f.title]?.title).trim();
    if (!title) continue;

    const body = await pageMarkdown(row.pageId).catch(() => "");
    if (body.trim().length < 40) continue;

    // Prefer the link's own course; otherwise read the Class column.
    let courseId = link.course_id;
    if (!courseId && f.courseSelect) {
      const label = row.props?.[f.courseSelect]?.select?.name ?? "";
      courseId = matchCourse(label, codeToId) ?? null;
    }

    const id = `notion:${row.pageId}`;
    db.prepare(
      `INSERT INTO notes (id, course_id, title, body) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         course_id = COALESCE(excluded.course_id, notes.course_id),
         updated_at = datetime('now')`,
    ).run(id, courseId, title, body);
    out.pulled++;
  }
  return out;
}

/** "HIST 230" or "INFO253-26S2" → a course id, when one plainly matches. */
function matchCourse(label: string, codeToId: Map<string, string>): string | null {
  const want = normalise(label);
  if (!want) return null;
  for (const [code, id] of codeToId) {
    if (code === want) return id;
    const bare = code.replace(/\s*\d{2}[a-z]\d\s*$/i, "").trim();
    if (bare && (bare === want || want.replace(/\s+/g, "") === bare.replace(/\s+/g, ""))) return id;
  }
  return null;
}

/** A Notion page's body as markdown, so it can live in the notes table. */
async function pageMarkdown(pageId: string): Promise<string> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion<{ results: any[]; next_cursor: string | null; has_more: boolean }>(
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    parts.push(blocksToMarkdown(page.results));
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return parts.join("\n").trim();
}

/**
 * Copy just the editable numbers off a row we created, so a weighting the
 * student typed onto it comes home. Never the title — that's ours.
 */
function applyPulled(
  row: ExistingRow,
  f: FieldMap,
  schema: LinkedSchema,
  assessmentId: string,
  db: ReturnType<typeof getDb>,
): void {
  const weightRaw = f.weight ? row.props?.[f.weight]?.number : null;
  const weight =
    weightRaw != null ? weightFromNotion(weightRaw, schema.numberFormats[f.weight!]) : null;
  const score = f.score ? (row.props?.[f.score]?.number ?? null) : null;
  const maxScore = f.maxScore ? (row.props?.[f.maxScore]?.number ?? null) : null;
  if (weight == null && score == null && maxScore == null) return;
  db.prepare(
    `UPDATE assessments SET
       weight = COALESCE(?, weight),
       score = COALESCE(?, score),
       max_score = COALESCE(?, max_score),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(weight, score, maxScore, assessmentId);
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The identity of an assessment, for matching the same thing described two ways.
 *
 * Moodle names a gradebook item "Individual Reflective Journal for Workshop One"
 * and the calendar event for the very same thing "…Workshop One is due", so
 * comparing titles verbatim pushed both and Notion ended up with two rows per
 * assignment. Strip the decorations Moodle adds around a deadline before
 * comparing.
 */
function titleKey(title: string): string {
  return normalise(
    title
      .replace(/^(due|opens|closes)\s*:\s*/i, "")
      .replace(/\s*\((due date|opens|closes|submission)\)\s*$/i, "")
      .replace(/\s+(is|are)\s+due\s*$/i, "")
      .replace(/\s+due\s*$/i, "")
      .replace(/\s+closes\s*$/i, ""),
  );
}

/** Re-exported so existing callers keep working. */
export { linkFor, listLinks, notionConnected } from "./notion-links.js";
