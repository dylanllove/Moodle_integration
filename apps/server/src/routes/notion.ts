import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";
import {
  inventory,
  notionConfigured,
  pageIdFrom,
  parentPage,
  readSchemaSafe,
  saveToken,
  setParentPage,
  verifyToken,
} from "../notion.js";
import {
  createDatabase,
  deleteLink,
  linkFor,
  listLinks,
  notionConnected,
  saveLink,
  suggestLinks,
  type Direction,
  type LinkKind,
} from "../notion-links.js";
import { syncNotion } from "../notion-sync.js";

const KINDS: LinkKind[] = ["assessments", "notes"];
const DIRECTIONS: Direction[] = ["push", "pull", "both"];

/**
 * Notion setup and sync.
 *
 * The shape of this API follows what actually goes wrong when people connect
 * Notion: they paste a link that doesn't parse, or they connect successfully and
 * then discover the app has built its own table beside the ones they already
 * keep. So connecting is split from choosing a destination, and choosing a
 * destination offers what Notion says is already there.
 */
export async function registerNotionRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get("/api/notion/status", async () => {
    const links = listLinks();
    const courses = db
      .prepare("SELECT id, code, name FROM courses WHERE active = 1 ORDER BY code")
      .all() as { id: string; code: string | null; name: string }[];
    return {
      configured: notionConfigured(),
      connected: notionConnected(),
      parentPage: parentPage(),
      links,
      courses,
    };
  });

  /**
   * Step one: prove the secret works. Returns the workspace inventory so the UI
   * can offer a list of real destinations instead of asking for a URL.
   */
  app.post<{ Body: { token?: string } }>("/api/notion/token", async (req, reply) => {
    const token = (req.body?.token ?? "").trim();
    if (!token) return reply.code(400).send({ error: "Paste your Notion integration secret." });
    try {
      const { name } = await verifyToken(token);
      saveToken(token);
      const inv = await inventory();
      return { ok: true, name, pages: inv.pages, databases: inv.databases };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Re-read the workspace (after sharing another page with the integration). */
  app.get("/api/notion/inventory", async (_req, reply) => {
    if (!notionConfigured()) return reply.code(400).send({ error: "Add your Notion secret first." });
    try {
      return { ok: true, ...(await inventory()) };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** What we think maps to what, for the student to confirm or change. */
  app.get("/api/notion/suggest", async (_req, reply) => {
    if (!notionConfigured()) return reply.code(400).send({ error: "Add your Notion secret first." });
    try {
      return { ok: true, ...(await suggestLinks()) };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** The page new databases get created under. */
  app.put<{ Body: { page?: string } }>("/api/notion/parent", async (req, reply) => {
    const id = pageIdFrom(req.body?.page ?? "");
    if (!id) {
      return reply.code(400).send({
        error:
          "That doesn't look like a Notion page link or id. Open the page → ••• → Copy link, and paste that.",
      });
    }
    // Confirm it's reachable before saving, so a typo fails here rather than
    // halfway through a sync.
    try {
      await readSchemaSafe(id);
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
    setParentPage(id);
    return { ok: true, parentPage: id };
  });

  /** Point a course (or everything) at a database that already exists. */
  app.put<{
    Body: { course_id?: string | null; kind?: string; notion?: string; direction?: string };
  }>("/api/notion/links", async (req, reply) => {
    const kind = req.body?.kind as LinkKind;
    if (!KINDS.includes(kind)) {
      return reply.code(400).send({ error: `kind must be one of ${KINDS.join(", ")}` });
    }
    const notionId = pageIdFrom(req.body?.notion ?? "");
    if (!notionId) {
      return reply.code(400).send({ error: "Pick a database, or paste its Notion link." });
    }
    const direction = DIRECTIONS.includes(req.body?.direction as Direction)
      ? (req.body!.direction as Direction)
      : "both";

    try {
      const schema = await readSchemaSafe(notionId);
      const link = saveLink({
        course_id: req.body?.course_id ?? null,
        kind,
        notion_id: notionId,
        notion_url: schema.url,
        title: schema.title,
        direction,
      });
      return { ok: true, link, fields: schema.fields, shape: schema.shape };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Create one in the student's own style, when there's nothing to reuse. */
  app.post<{ Body: { course_id?: string | null; kind?: string; title?: string; page?: string } }>(
    "/api/notion/databases",
    async (req, reply) => {
      const kind = req.body?.kind as LinkKind;
      if (!KINDS.includes(kind)) {
        return reply.code(400).send({ error: `kind must be one of ${KINDS.join(", ")}` });
      }
      const parent = req.body?.page ? pageIdFrom(req.body.page) : parentPage();
      if (!parent) {
        return reply
          .code(400)
          .send({ error: "Choose the Notion page it should live under first." });
      }
      const course = req.body?.course_id
        ? (db.prepare("SELECT code, name FROM courses WHERE id = ?").get(req.body.course_id) as
            | { code: string | null; name: string }
            | undefined)
        : undefined;
      const title =
        req.body?.title?.trim() ||
        (course
          ? `${course.code ?? course.name} — ${kind === "assessments" ? "Assessments" : "Notes"}`
          : kind === "assessments"
            ? "Assessments"
            : "Class Notes");

      try {
        const made = await createDatabase({ kind, title, parentPageId: parent });
        const link = saveLink({
          course_id: req.body?.course_id ?? null,
          kind,
          notion_id: made.id,
          notion_url: made.url,
          title: made.title,
        });
        return { ok: true, link, created: true };
      } catch (e) {
        return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/notion/links/:id", async (req) => {
    deleteLink(req.params.id);
    return { ok: true, links: listLinks() };
  });

  /** Both directions, every link. */
  app.post("/api/notion/sync", async (_req, reply) => {
    if (!notionConnected()) {
      return reply.code(400).send({ error: "Notion isn't connected — link a database first." });
    }
    try {
      return { ok: true, ...(await syncNotion()) };
    } catch (e) {
      return reply.code(500).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Preview what a linked database looks like to us — the mapping, in words. */
  app.get<{ Querystring: { id?: string } }>("/api/notion/schema", async (req, reply) => {
    const id = pageIdFrom(req.query.id ?? "");
    if (!id) return reply.code(400).send({ error: "Pass a database id or link." });
    try {
      return { ok: true, ...(await readSchemaSafe(id)) };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  void linkFor;
}
