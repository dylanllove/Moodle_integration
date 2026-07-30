import type { FastifyInstance } from "fastify";
import { getDb, getSetting, setSetting } from "@uni/db";
import { googleConfigured, googleConnected, pushToGoogleCalendar } from "../google.js";
import {
  connect as notionConnect,
  notionConfigured,
  notionConnected,
  pushToNotion,
} from "../notion.js";

/**
 * Where deadlines go: Google Calendar, Apple Calendar (via the .ics feed), and
 * Notion. One status endpoint and one "push everywhere" button, because the
 * student's mental model is "keep my calendar up to date", not three integrations.
 */
export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sync/status", async (req) => {
    const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? 8787}`;
    return {
      google: {
        configured: googleConfigured(),
        connected: googleConnected(),
        lastPush: getSetting("gcal_last_push"),
        includeClasses: getSetting("gcal_include_classes") === "true",
        includePersonal: getSetting("gcal_include_personal") === "true",
      },
      apple: {
        // Nothing to connect — subscribing is the whole integration.
        webcal: `webcal://${host}/api/calendar.ics`,
        https: `http://${host}/api/calendar.ics`,
        subscribed: getSetting("ics_subscribed") === "true",
      },
      notion: {
        configured: notionConfigured(),
        connected: notionConnected(),
        databaseUrl: getSetting("notion_database_url"),
        lastPush: getSetting("notion_last_push"),
      },
      autoPush: getSetting("auto_push_on_sync") !== "false",
      deadlines: (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM events
             WHERE kind IN ('deadline','exam')
               AND (course_id IS NULL OR course_id IN (SELECT id FROM courses WHERE active = 1))`,
          )
          .get() as { n: number }
      ).n,
    };
  });

  /** Push to every connected destination, reporting each outcome separately. */
  app.post("/api/sync/push", async () => {
    const out: Record<string, unknown> = {};
    if (googleConnected()) {
      out.google = await pushToGoogleCalendar()
        .then((r) => ({ ok: true, ...r }))
        .catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    }
    if (notionConnected()) {
      out.notion = await pushToNotion()
        .then((r) => ({ ok: true, ...r }))
        .catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    }
    return { ok: true, ...out };
  });

  /** Auto-push after every Moodle sync (on by default once something's connected). */
  app.put<{ Body: { autoPush?: boolean; appleSubscribed?: boolean } }>(
    "/api/sync/options",
    async (req) => {
      if (req.body?.autoPush !== undefined)
        setSetting("auto_push_on_sync", req.body.autoPush ? "true" : "false");
      // Purely a UI memory so the Apple card can stop nagging once it's done.
      if (req.body?.appleSubscribed !== undefined)
        setSetting("ics_subscribed", req.body.appleSubscribed ? "true" : "false");
      return { ok: true };
    },
  );

  // --- Notion -------------------------------------------------------------
  app.post<{ Body: { token?: string; page?: string } }>("/api/notion/connect", async (req, reply) => {
    const token = (req.body?.token ?? "").trim();
    const page = (req.body?.page ?? "").trim();
    if (!token) return reply.code(400).send({ error: "Paste your Notion integration secret." });
    if (!page) {
      return reply
        .code(400)
        .send({ error: "Paste the link to the Notion page you shared with the integration." });
    }
    try {
      return { ok: true, ...(await notionConnect(token, page)) };
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.post("/api/notion/push", async (_req, reply) => {
    if (!notionConnected()) return reply.code(400).send({ error: "Notion isn't connected." });
    try {
      return { ok: true, ...(await pushToNotion()) };
    } catch (e) {
      return reply.code(500).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.post("/api/notion/disconnect", async () => {
    setSetting("notion_database_id", "");
    setSetting("notion_database_url", "");
    setSetting("notion_parent_page", "");
    return { ok: true };
  });
}
