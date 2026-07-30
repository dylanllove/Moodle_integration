import { getDb, getSetting, setSetting } from "@uni/db";
import { saveEnv } from "./env-file.js";
import { courseGrades } from "./grades.js";

/**
 * Notion sync — mirrors deadlines into a Notion database the student owns.
 *
 * Uses an *internal integration* token rather than OAuth: for a local, one-user
 * app that's two clicks (Notion → My integrations → New → copy secret → share a
 * page with it) versus registering a public OAuth app. The token lives in .env
 * alongside the other secrets.
 *
 * Pinned to API version 2022-06-28, whose database endpoints are stable; the
 * 2025 data-source split would buy nothing here.
 */
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

const TOKEN = () => process.env.NOTION_TOKEN ?? "";

export function notionConfigured(): boolean {
  return Boolean(TOKEN());
}

export function notionConnected(): boolean {
  return Boolean(TOKEN() && getSetting("notion_database_id"));
}

export function notionDatabaseId(): string | null {
  return getSetting("notion_database_id");
}

async function notion<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!TOKEN()) throw new Error("Notion isn't connected — add your integration secret first.");
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${TOKEN()}`,
      "Notion-Version": VERSION,
      "content-type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    // Notion's own messages are unusually good; surface them rather than a code.
    throw new Error(json?.message ?? `Notion returned ${res.status}`);
  }
  return json as T;
}

/** Confirm a secret works and report the integration's name. */
export async function verifyToken(token: string): Promise<{ name: string }> {
  const res = await fetch(`${API}/users/me`, {
    headers: { authorization: `Bearer ${token}`, "Notion-Version": VERSION },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Notion rejected that secret. Copy it again from notion.so/my-integrations.");
    }
    throw new Error(json?.message ?? `Notion returned ${res.status}`);
  }
  return { name: json?.name ?? json?.bot?.owner?.user?.name ?? "your integration" };
}

/**
 * A Notion page id is the trailing 32 hex characters of its URL. Accept a raw
 * id, a dashed id, or a pasted link — students paste links.
 */
export function pageIdFrom(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-f]/gi, "");
  const id = hex.length >= 32 ? hex.slice(-32) : null;
  if (!id) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export interface ConnectResult {
  name: string;
  databaseId: string;
  url: string;
  created: boolean;
}

/**
 * Save the secret, then find or create the deadlines database under the page the
 * student shared with the integration.
 */
export async function connect(token: string, parentRaw: string): Promise<ConnectResult> {
  const { name } = await verifyToken(token.trim());
  saveEnv({ NOTION_TOKEN: token.trim() });

  const parentId = pageIdFrom(parentRaw);
  if (!parentId) {
    throw new Error(
      "That doesn't look like a Notion page link. Open the page → Share → Copy link, and paste that.",
    );
  }
  setSetting("notion_parent_page", parentId);

  // Reuse a database we made earlier if it's still there — reconnecting
  // shouldn't leave a graveyard of empty databases behind.
  const existing = getSetting("notion_database_id");
  if (existing) {
    const db = await notion<{ id: string; url: string; archived?: boolean }>(
      `/databases/${existing}`,
    ).catch(() => null);
    if (db && !db.archived) return { name, databaseId: db.id, url: db.url, created: false };
  }

  const created = await notion<{ id: string; url: string }>("/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parentId },
      icon: { type: "emoji", emoji: "🎓" },
      title: [{ type: "text", text: { content: "Uni Study — Deadlines" } }],
      properties: {
        Name: { title: {} },
        Due: { date: {} },
        Course: { select: {} },
        Type: {
          select: {
            options: [
              { name: "Deadline", color: "red" },
              { name: "Exam", color: "purple" },
              { name: "Opens", color: "gray" },
            ],
          },
        },
        Weight: { number: { format: "percent" } },
        Status: {
          select: {
            options: [
              { name: "Upcoming", color: "yellow" },
              { name: "Overdue", color: "red" },
              { name: "Done", color: "green" },
            ],
          },
        },
        Link: { url: {} },
        "Uni ID": { rich_text: {} },
      },
    },
  });

  setSetting("notion_database_id", created.id);
  setSetting("notion_database_url", created.url);
  return { name, databaseId: created.id, url: created.url, created: true };
}

export interface NotionPushResult {
  created: number;
  updated: number;
  archived: number;
}

/**
 * Push every active-course deadline, exam and opening date into the database,
 * matching on the "Uni ID" property so a re-sync updates rather than duplicates.
 * Rows whose source event has gone are archived, not left to rot.
 */
export async function pushToNotion(): Promise<NotionPushResult> {
  const databaseId = getSetting("notion_database_id");
  if (!databaseId) throw new Error("Notion isn't connected yet.");
  const out: NotionPushResult = { created: 0, updated: 0, archived: 0 };

  const events = getDb()
    .prepare(
      `SELECT e.id, e.title, e.kind, e.start_at, e.url, c.code AS course_code
       FROM events e LEFT JOIN courses c ON c.id = e.course_id
       WHERE e.kind IN ('deadline','exam','open')
         AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))
       ORDER BY e.start_at`,
    )
    .all() as EventRow[];

  const weights = weightIndex();
  const existing = await allRows(databaseId);
  const seen = new Set<string>();

  for (const e of events) {
    seen.add(e.id);
    const props = propsFor(e, weights);
    const pageId = existing.get(e.id);
    if (pageId) {
      await notion(`/pages/${pageId}`, { method: "PATCH", body: { properties: props } });
      out.updated++;
    } else {
      await notion("/pages", {
        method: "POST",
        body: { parent: { database_id: databaseId }, properties: props },
      });
      out.created++;
    }
  }

  for (const [uniId, pageId] of existing) {
    if (seen.has(uniId)) continue;
    await notion(`/pages/${pageId}`, { method: "PATCH", body: { archived: true } });
    out.archived++;
  }

  setSetting("notion_last_push", new Date().toISOString());
  return out;
}

/** Every row already in the database, keyed by our event id. */
async function allRows(databaseId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
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
      const id = (row.properties?.["Uni ID"]?.rich_text ?? [])
        .map((t: any) => t?.plain_text ?? "")
        .join("");
      if (id) map.set(id, row.id);
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return map;
}

function propsFor(e: EventRow, weights: Map<string, number>): Record<string, unknown> {
  const clean = e.title.replace(/^(Due|Opens):\s*/i, "");
  const overdue = new Date(e.start_at).getTime() < Date.now();
  const weight = weights.get(normalise(clean));
  return {
    Name: { title: [{ type: "text", text: { content: clean.slice(0, 200) } }] },
    Due: { date: { start: e.start_at } },
    Course: e.course_code ? { select: { name: e.course_code.slice(0, 100) } } : { select: null },
    Type: { select: { name: e.kind === "exam" ? "Exam" : e.kind === "open" ? "Opens" : "Deadline" } },
    // Notion's percent format wants a fraction.
    Weight: { number: weight != null ? weight / 100 : null },
    Status: { select: { name: overdue ? "Overdue" : "Upcoming" } },
    Link: { url: e.url || null },
    "Uni ID": { rich_text: [{ type: "text", text: { content: e.id } }] },
  };
}

/**
 * Assessment weights by title, so a Notion row shows what it's worth. Goes
 * through the calculator rather than the table so a grouped item reports its
 * resolved share rather than a blank.
 */
function weightIndex(): Map<string, number> {
  const out = new Map<string, number>();
  for (const course of courseGrades()) {
    for (const a of course.assessments) {
      if (a.effectiveWeight > 0) out.set(normalise(a.title), a.effectiveWeight);
    }
  }
  return out;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type EventRow = {
  id: string;
  title: string;
  kind: string;
  start_at: string;
  url: string | null;
  course_code: string | null;
}
