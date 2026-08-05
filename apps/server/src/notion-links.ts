import { randomUUID } from "node:crypto";
import { getDb } from "@uni/db";
import {
  classify,
  inventory,
  mapFields,
  notion,
  parentPage,
  type FieldMap,
  type NotionShape,
} from "./notion.js";

/**
 * Which Notion database each course talks to.
 *
 * The old integration had exactly one destination: a database it created itself,
 * called "Uni Study — Deadlines", at the top of whatever page you pointed it at.
 * That's fine if you have no Notion setup and terrible if you do — it ignores the
 * trackers you built and adds a competing one. A link says "this course's
 * assessments live in *that* database of yours", and the sync writes in the
 * shape it finds there.
 */
export type LinkKind = "assessments" | "notes";
export type Direction = "push" | "pull" | "both";

export interface NotionLink {
  id: string;
  course_id: string | null;
  kind: LinkKind;
  notion_id: string;
  notion_url: string | null;
  title: string | null;
  direction: Direction;
  last_push: string | null;
  last_pull: string | null;
}

export function listLinks(): NotionLink[] {
  return getDb()
    .prepare("SELECT * FROM notion_links ORDER BY kind, course_id IS NULL DESC, course_id")
    .all() as unknown as NotionLink[];
}

/**
 * The link that governs a course, falling back to the workspace-wide one.
 * A per-course mapping always wins over the catch-all.
 */
export function linkFor(courseId: string | null, kind: LinkKind): NotionLink | null {
  const db = getDb();
  const specific = courseId
    ? (db
        .prepare("SELECT * FROM notion_links WHERE kind = ? AND course_id = ?")
        .get(kind, courseId) as unknown as NotionLink | undefined)
    : undefined;
  if (specific) return specific;
  return (db
    .prepare("SELECT * FROM notion_links WHERE kind = ? AND course_id IS NULL")
    .get(kind) as unknown as NotionLink | undefined) ?? null;
}

export function saveLink(input: {
  course_id: string | null;
  kind: LinkKind;
  notion_id: string;
  notion_url?: string | null;
  title?: string | null;
  direction?: Direction;
}): NotionLink {
  const db = getDb();
  db.prepare(
    `INSERT INTO notion_links (id, course_id, kind, notion_id, notion_url, title, direction)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(kind, IFNULL(course_id, '')) DO UPDATE SET
       notion_id = excluded.notion_id,
       notion_url = excluded.notion_url,
       title = excluded.title,
       direction = excluded.direction,
       updated_at = datetime('now')`,
  ).run(
    randomUUID(),
    input.course_id,
    input.kind,
    input.notion_id,
    input.notion_url ?? null,
    input.title ?? null,
    input.direction ?? "both",
  );
  return linkFor(input.course_id, input.kind)!;
}

export function deleteLink(id: string): void {
  getDb().prepare("DELETE FROM notion_links WHERE id = ?").run(id);
}

export function stampLink(id: string, which: "last_push" | "last_pull"): void {
  getDb()
    .prepare(`UPDATE notion_links SET ${which} = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}

/** Connected once there's a token and somewhere to put things. */
export function notionConnected(): boolean {
  return Boolean(process.env.NOTION_TOKEN) && listLinks().length > 0;
}

/* --- Suggesting links ------------------------------------------------------ */

export interface Suggestion {
  course_id: string | null;
  courseCode: string | null;
  kind: LinkKind;
  notion_id: string;
  title: string;
  url: string;
  /** Why we think these belong together — shown to the student, who decides. */
  because: string;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Guess the mapping from what's already in Notion.
 *
 * A database called "INFO253" or "MGMT244 Assessments" plainly belongs to that
 * course, and one shaped like an assessment tracker plainly holds assessments.
 * These are proposals, never applied silently — the student confirms them, and a
 * wrong guess costs a dropdown change rather than a wrongly-populated table.
 */
export async function suggestLinks(): Promise<{ suggestions: Suggestion[]; unmatched: string[] }> {
  const inv = await inventory();
  const courses = getDb()
    .prepare("SELECT id, code, name FROM courses WHERE active = 1")
    .all() as { id: string; code: string | null; name: string }[];

  const suggestions: Suggestion[] = [];
  const used = new Set<string>();

  for (const db of inv.databases) {
    const shape = db.shape;
    if (shape === "unknown") continue;
    const hay = normalise(db.title);

    // A course code in the database's title is about as clear as a signal gets.
    const match = courses.find((c) => {
      const code = normalise(c.code ?? "");
      if (!code) return false;
      // Compare on the bare code too: "INFO253-26S2" should match "INFO 253".
      const bare = code.replace(/\s*\d{2}[a-z]\d\s*$/i, "").trim();
      return hay.includes(code) || (bare.length >= 5 && hay.includes(bare));
    });

    suggestions.push({
      course_id: match?.id ?? null,
      courseCode: match?.code ?? null,
      kind: shape,
      notion_id: db.id,
      title: db.title,
      url: db.url,
      because: match
        ? `"${db.title}" names ${match.code} and is laid out like ${shape === "assessments" ? "an assessment tracker" : "a notes table"}`
        : `"${db.title}" is laid out like ${shape === "assessments" ? "an assessment tracker" : "a notes table"}`,
    });
    used.add(db.id);
  }

  const unmatched = courses
    .filter((c) => !suggestions.some((s) => s.course_id === c.id))
    .map((c) => c.code ?? c.name);
  return { suggestions, unmatched };
}

/* --- Creating one, in the student's own style ------------------------------ */

/**
 * The columns to give a database we have to create ourselves.
 *
 * Copied from the shapes already in the workspace rather than invented: the
 * assessment layout mirrors their per-course grade tracker (Assignment / Due /
 * Weighting as a percent / Raw Score), and the notes layout mirrors their Class
 * Notes table (Name / Class / Type / Reviewed). Formulas are deliberately left
 * out — Notion's formula expressions reference property *ids* from the database
 * they were written in, so copying them across produces a broken column.
 */
function schemaFor(kind: LinkKind): Record<string, unknown> {
  if (kind === "assessments") {
    return {
      Assignment: { title: {} },
      Due: { date: {} },
      Weighting: { number: { format: "percent" } },
      "Raw Score": { number: { format: "number" } },
      Submitted: { date: {} },
      Type: {
        select: {
          options: [
            { name: "Assignment", color: "blue" },
            { name: "Exam", color: "purple" },
            { name: "Test", color: "orange" },
          ],
        },
      },
      Link: { url: {} },
      "Uni ID": { rich_text: {} },
    };
  }
  return {
    Name: { title: {} },
    Class: { select: {} },
    Type: {
      select: {
        options: [
          { name: "Lecture", color: "blue" },
          { name: "Reading", color: "green" },
          { name: "Seminar", color: "orange" },
        ],
      },
    },
    Reviewed: { checkbox: {} },
    Link: { url: {} },
    "Uni ID": { rich_text: {} },
  };
}

export async function createDatabase(opts: {
  kind: LinkKind;
  title: string;
  parentPageId?: string;
}): Promise<{ id: string; url: string; title: string }> {
  const parent = opts.parentPageId ?? parentPage();
  if (!parent) {
    throw new Error(
      "Pick a Notion page to create it under first — Notion won't let an integration create a top-level database.",
    );
  }
  const created = await notion<{ id: string; url: string }>("/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parent },
      icon: { type: "emoji", emoji: opts.kind === "assessments" ? "🎯" : "📓" },
      title: [{ type: "text", text: { content: opts.title.slice(0, 200) } }],
      properties: schemaFor(opts.kind),
    },
  });
  return { id: created.id, url: created.url, title: opts.title };
}

/* --- Reading a linked database's schema ----------------------------------- */

export interface LinkedSchema {
  fields: FieldMap;
  numberFormats: Record<string, string>;
  shape: NotionShape;
  title: string;
}

/**
 * What we're allowed to write, for one linked database. Cached per sync run —
 * pushing thirty rows shouldn't re-read the schema thirty times.
 */
export async function readSchema(databaseId: string): Promise<LinkedSchema> {
  const db = await notion<{ title: any[]; properties: Record<string, any> }>(
    `/databases/${databaseId}`,
  );
  const properties: Record<string, string> = {};
  const numberFormats: Record<string, string> = {};
  for (const [key, value] of Object.entries(db.properties ?? {})) {
    properties[key] = value?.type ?? "unknown";
    if (value?.type === "number") numberFormats[key] = value.number?.format ?? "number";
  }
  return {
    fields: mapFields(properties),
    numberFormats,
    shape: classify(properties),
    title: (db.title ?? []).map((t: any) => t?.plain_text ?? "").join("") || "Untitled",
  };
}

/**
 * Add a column the student's database doesn't have but the sync needs.
 *
 * Only ever used for "Uni ID", the hidden stamp that lets a re-sync update a row
 * instead of adding a second copy of it. Without it every push would duplicate
 * everything, and matching on the title alone would break the moment they renamed
 * a row — which is exactly the kind of ownership the student should keep.
 */
export async function ensureUniIdColumn(databaseId: string, existing: FieldMap): Promise<string> {
  if (existing.uniId) return existing.uniId;
  await notion(`/databases/${databaseId}`, {
    method: "PATCH",
    body: { properties: { "Uni ID": { rich_text: {} } } },
  });
  return "Uni ID";
}
