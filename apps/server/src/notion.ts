import { getSetting, setSetting } from "@uni/db";
import { saveEnv } from "./env-file.js";

/**
 * Notion client, id parsing and workspace discovery.
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

export async function notion<T = any>(
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

/* --- Ids ------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dashify = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/**
 * The id at the end of a Notion link, or a bare id.
 *
 * This used to strip every non-hex character from the whole string and keep the
 * last 32 — which quietly ate the URL itself. "app.notion.com" contributes "ac",
 * a slug like "Sem-2-Study-" contributes "e2d", and the "?source=copy_link"
 * that Notion's Copy-link button now appends contributes "cec": eight stray
 * characters that shifted the window eight places into the real id, producing a
 * well-formed UUID belonging to nothing. Parse the URL as a URL instead.
 */
export function pageIdFrom(raw: string): string | null {
  const input = (raw ?? "").trim();
  if (!input) return null;

  // A bare id, dashed or not.
  const bare = input.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(bare)) return dashify(bare.toLowerCase());

  // A link: the id is the tail of the last path segment. Query and fragment are
  // dropped first — "?v=" (a database view) and "?source=" both live there.
  const withoutQuery = input.split(/[?#]/)[0] ?? "";
  const segment = withoutQuery.split("/").filter(Boolean).pop() ?? "";

  const dashed = segment.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (dashed) return dashed[1]!.toLowerCase();

  // Slugs are "Some-Page-Title-<32 hex>", so anchor to the end and require that
  // the run is exactly 32 — a longer run of hex is not an id.
  const plain = segment.match(/(^|[^0-9a-f])([0-9a-f]{32})$/i);
  if (plain) return dashify(plain[2]!.toLowerCase());

  return null;
}

/** True if a string is already a usable Notion id. */
export function isNotionId(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/* --- What can the integration see? ---------------------------------------- */

export type NotionShape = "assessments" | "notes" | "unknown";

export interface NotionTarget {
  id: string;
  object: "page" | "database";
  title: string;
  url: string;
  /** "workspace", or the id of the parent page/database. */
  parent: string;
  /** For databases: what this looks like it's for, and how sure we are. */
  shape: NotionShape;
  properties: Record<string, string>;
}

export interface Inventory {
  name: string;
  pages: NotionTarget[];
  databases: NotionTarget[];
}

const titleOf = (node: any): string => {
  const rich = node?.title ?? node?.properties?.title?.title ?? [];
  const text = (Array.isArray(rich) ? rich : []).map((t: any) => t?.plain_text ?? "").join("").trim();
  if (text) return text;
  // Database rows have their title under whatever the title property is called.
  for (const value of Object.values(node?.properties ?? {}) as any[]) {
    if (value?.type === "title") {
      const t = (value.title ?? []).map((x: any) => x?.plain_text ?? "").join("").trim();
      if (t) return t;
    }
  }
  return "Untitled";
};

/**
 * Everything the integration has been given access to.
 *
 * Asking someone to find and paste a page URL is the step that goes wrong: the
 * link has a slug on it, a query string, and no indication of whether the page
 * was actually shared with the integration. Notion will just tell us what it can
 * see, so the connect flow can offer a list instead of a text box.
 */
export async function inventory(): Promise<Inventory> {
  const { name } = await verifyToken(TOKEN());
  const pages: NotionTarget[] = [];
  const databases: NotionTarget[] = [];

  let cursor: string | undefined;
  do {
    const page = await notion<{
      results: any[];
      next_cursor: string | null;
      has_more: boolean;
    }>("/search", {
      method: "POST",
      body: { page_size: 100, start_cursor: cursor },
    });

    for (const node of page.results) {
      const properties: Record<string, string> = {};
      for (const [key, value] of Object.entries((node.properties ?? {}) as Record<string, any>)) {
        properties[key] = value?.type ?? "unknown";
      }
      const target: NotionTarget = {
        id: node.id,
        object: node.object,
        title: titleOf(node),
        url: node.url ?? "",
        parent:
          node.parent?.type === "workspace"
            ? "workspace"
            : (node.parent?.page_id ?? node.parent?.database_id ?? "workspace"),
        shape: node.object === "database" ? classify(properties) : "unknown",
        properties,
      };
      if (node.object === "database") databases.push(target);
      // Rows inside a database are pages too, and they are never a sync target.
      else if (node.parent?.type !== "database_id") pages.push(target);
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);

  const byTitle = (a: NotionTarget, b: NotionTarget) => a.title.localeCompare(b.title);
  return { name, pages: pages.sort(byTitle), databases: databases.sort(byTitle) };
}

/* --- Reading someone else's schema ---------------------------------------- */

/**
 * Which property in *this* database means what.
 *
 * The point of the whole exercise is to write into the databases the student
 * already built, so nothing here may assume a column is called "Weighting" —
 * their other tracker calls the same idea "Weight", and a third might call it
 * "Worth" or "%". Each role is matched by name affinity against the columns that
 * actually exist, falling back to the only column of the right type.
 */
export interface FieldMap {
  title: string | null;
  due: string | null;
  weight: string | null;
  score: string | null;
  maxScore: string | null;
  submitted: string | null;
  courseSelect: string | null;
  typeSelect: string | null;
  reviewed: string | null;
  link: string | null;
  /** Where we stamp our own id so a re-sync updates instead of duplicating. */
  uniId: string | null;
}

const ROLE_HINTS: Record<Exclude<keyof FieldMap, "title">, { types: string[]; words: RegExp }> = {
  due: { types: ["date"], words: /^(due|due date|deadline|when|date)$/i },
  weight: { types: ["number"], words: /(weight|worth|percent|%|contribution)/i },
  score: { types: ["number"], words: /(raw score|score|mark|grade|result|earned)/i },
  maxScore: { types: ["number"], words: /(out of|max|total|possible)/i },
  submitted: { types: ["date"], words: /(submitted|handed|turned in)/i },
  courseSelect: { types: ["select", "multi_select"], words: /(class|course|paper|subject|unit)/i },
  typeSelect: { types: ["select", "multi_select"], words: /(type|kind|category|format)/i },
  reviewed: { types: ["checkbox"], words: /(reviewed|done|complete|read|studied)/i },
  link: { types: ["url"], words: /(link|url|source)/i },
  uniId: { types: ["rich_text"], words: /(uni id|uni-id|sync id|external id)/i },
};

/**
 * Roles we'll claim from a lone column of the right type when nothing is named
 * helpfully. Everything else must say what it is.
 *
 * The temptation is to take any single candidate, but that maps a tracker's only
 * checkbox — "Excused" — to "Reviewed", and its only number to whichever of
 * weight-or-mark we happened to ask about first. Writing the wrong value into
 * someone's own database is worse than leaving a column alone and saying so, and
 * anybody who keeps an assessment table does label the mark and the weighting.
 */
const TYPE_FALLBACK_OK = new Set<keyof FieldMap>(["due", "link", "uniId"]);

export function mapFields(properties: Record<string, string>): FieldMap {
  const entries = Object.entries(properties);
  const titleProp = entries.find(([, type]) => type === "title")?.[0] ?? null;

  const pick = (role: Exclude<keyof FieldMap, "title">): string | null => {
    const hint = ROLE_HINTS[role];
    const candidates = entries.filter(([, type]) => hint.types.includes(type));
    // A name that says what it is beats a lucky guess by type.
    const named = candidates.find(([key]) => hint.words.test(key));
    if (named) return named[0];
    if (!TYPE_FALLBACK_OK.has(role)) return null;
    // Even then, don't grab a column that plainly belongs to another role.
    const unclaimed = candidates.filter(
      ([key]) =>
        !Object.entries(ROLE_HINTS).some(([other, h]) => other !== role && h.words.test(key)),
    );
    return unclaimed.length === 1 ? unclaimed[0]![0] : null;
  };

  const map: FieldMap = {
    title: titleProp,
    due: pick("due"),
    weight: pick("weight"),
    score: pick("score"),
    maxScore: pick("maxScore"),
    submitted: pick("submitted"),
    courseSelect: pick("courseSelect"),
    typeSelect: pick("typeSelect"),
    reviewed: pick("reviewed"),
    link: pick("link"),
    uniId: pick("uniId"),
  };

  // One number column can't be both the mark and what it's out of.
  if (map.score && map.score === map.maxScore) map.maxScore = null;
  if (map.weight && map.weight === map.score) {
    // Prefer the explicitly-named one and drop the coincidence.
    if (ROLE_HINTS.weight.words.test(map.weight)) map.score = null;
    else map.weight = null;
  }
  if (map.courseSelect && map.courseSelect === map.typeSelect) map.typeSelect = null;
  return map;
}

/**
 * What is this database for? Decided from the columns, because the title won't
 * say — "English 001" is an assessment tracker and "Class Notes" isn't, and
 * neither name announces it.
 */
export function classify(properties: Record<string, string>): NotionShape {
  const f = mapFields(properties);
  if (!f.title) return "unknown";
  // A date plus a weight or a mark is an assessment tracker; that combination
  // doesn't occur on a notes table.
  if (f.due && (f.weight || f.score)) return "assessments";
  if (f.courseSelect || f.typeSelect || f.reviewed) return "notes";
  if (f.due) return "assessments";
  return "unknown";
}

/* --- Percent conventions --------------------------------------------------- */

/**
 * Notion's percent-formatted numbers hold a fraction (0.2 renders as 20%), while
 * the platform stores weights as 0–100. Getting this backwards silently turns a
 * 20% assignment into 0.2% of the grade, so the format is read off the column
 * rather than guessed.
 */
export function weightToNotion(weight: number, format: string | undefined): number {
  return format === "percent" ? weight / 100 : weight;
}

export function weightFromNotion(value: number, format: string | undefined): number {
  if (format === "percent") return value * 100;
  // An un-formatted column holding 0.2 still means 20% — nobody weights an
  // assessment at a fifth of one percent.
  return value > 0 && value <= 1 ? value * 100 : value;
}

/** The `number.format` of each numeric column, needed for the above. */
export async function numberFormats(databaseId: string): Promise<Record<string, string>> {
  const db = await notion<{ properties: Record<string, any> }>(`/databases/${databaseId}`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(db.properties ?? {})) {
    if (value?.type === "number") out[key] = value.number?.format ?? "number";
  }
  return out;
}

/**
 * Look up an id without needing to know whether it's a page or a database.
 *
 * Notion has separate endpoints for the two, and a student pasting a link has no
 * reason to know which one they've copied — a link to a database and a link to a
 * page are indistinguishable by eye. Try the database endpoint, fall back to the
 * page endpoint, and report which it turned out to be.
 */
export interface ResolvedTarget {
  id: string;
  object: "page" | "database";
  title: string;
  url: string;
  shape: NotionShape;
  fields: FieldMap;
  properties: Record<string, string>;
  numberFormats: Record<string, string>;
}

export async function readSchemaSafe(id: string): Promise<ResolvedTarget> {
  const asDatabase = await notion<any>(`/databases/${id}`).catch(() => null);
  if (asDatabase?.object === "database") {
    const properties: Record<string, string> = {};
    const numberFormats: Record<string, string> = {};
    for (const [key, value] of Object.entries(asDatabase.properties ?? {}) as [string, any][]) {
      properties[key] = value?.type ?? "unknown";
      if (value?.type === "number") numberFormats[key] = value.number?.format ?? "number";
    }
    return {
      id: asDatabase.id,
      object: "database",
      title: (asDatabase.title ?? []).map((t: any) => t?.plain_text ?? "").join("") || "Untitled",
      url: asDatabase.url ?? "",
      shape: classify(properties),
      fields: mapFields(properties),
      properties,
      numberFormats,
    };
  }

  const asPage = await notion<any>(`/pages/${id}`).catch((e) => {
    throw new Error(
      `Notion couldn't open that id. Make sure the page is shared with your integration — open it in Notion, click ••• → Connections → add your integration. (${e instanceof Error ? e.message : e})`,
    );
  });
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(asPage.properties ?? {}) as [string, any][]) {
    properties[key] = value?.type ?? "unknown";
  }
  return {
    id: asPage.id,
    object: "page",
    title: titleOf(asPage),
    url: asPage.url ?? "",
    shape: "unknown",
    fields: mapFields(properties),
    properties,
    numberFormats: {},
  };
}

/* --- Token + parent page bookkeeping -------------------------------------- */

/** saveEnv updates process.env too, so the new token is live immediately. */
export function saveToken(token: string): void {
  saveEnv({ NOTION_TOKEN: token.trim() });
}

export function parentPage(): string | null {
  return getSetting("notion_parent_page");
}

export function setParentPage(id: string): void {
  setSetting("notion_parent_page", id);
}
