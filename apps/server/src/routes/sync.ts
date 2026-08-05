import type { FastifyInstance } from "fastify";
import { getDb, getSetting, setSetting } from "@uni/db";
import { googleConfigured, googleConnected, pushToGoogleCalendar } from "../google.js";
import { notionConfigured } from "../notion.js";
import { listLinks, notionConnected } from "../notion-links.js";
import { syncNotion } from "../notion-sync.js";
import { runFullSync, syncRunning, syncState } from "../sync-job.js";
import { autoSyncSettings } from "../scheduler.js";

/**
 * Where deadlines go: Google Calendar, Apple Calendar (via the .ics feed), and
 * Notion. One status endpoint and one "push everywhere" button, because the
 * student's mental model is "keep my calendar up to date", not three integrations.
 */
export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Run the whole pipeline — the same one that runs at launch. Returns as soon
   * as it's started; a full sync can pull a semester of slide decks, so the UI
   * follows along on /api/sync/progress rather than holding a request open.
   */
  app.post("/api/sync/run", async () => {
    if (syncRunning()) return { ok: true, alreadyRunning: true, state: syncState() };
    void runFullSync(app);
    return { ok: true, alreadyRunning: false, state: syncState() };
  });

  app.get("/api/sync/progress", async () => ({ ...syncState(), auto: autoSyncSettings() }));

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
        databaseUrl: listLinks()[0]?.notion_url ?? null,
        links: listLinks().length,
        lastPush: getSetting("notion_last_push"),
      },
      autoPush: getSetting("auto_push_on_sync") !== "false",
      auto: autoSyncSettings(),
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
      out.notion = await syncNotion()
        .then((r) => ({ ok: true, ...r }))
        .catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    }
    return { ok: true, ...out };
  });

  /** Auto-push after every Moodle sync (on by default once something's connected). */
  app.put<{
    Body: {
      autoPush?: boolean;
      appleSubscribed?: boolean;
      autoSyncEnabled?: boolean;
      autoSyncMinutes?: number;
    };
  }>("/api/sync/options", async (req) => {
    if (req.body?.autoPush !== undefined)
      setSetting("auto_push_on_sync", req.body.autoPush ? "true" : "false");
    // Purely a UI memory so the Apple card can stop nagging once it's done.
    if (req.body?.appleSubscribed !== undefined)
      setSetting("ics_subscribed", req.body.appleSubscribed ? "true" : "false");
    if (req.body?.autoSyncEnabled !== undefined)
      setSetting("auto_sync_enabled", req.body.autoSyncEnabled ? "true" : "false");
    if (req.body?.autoSyncMinutes !== undefined) {
      // Below five minutes this stops being "keeping up" and starts being a
      // browser launching over and over on the student's laptop.
      const n = Math.min(24 * 60, Math.max(5, Math.round(req.body.autoSyncMinutes)));
      setSetting("auto_sync_minutes", String(n));
    }
    return { ok: true, auto: autoSyncSettings() };
  });
}
