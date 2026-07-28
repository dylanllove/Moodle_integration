import type { FastifyInstance } from "fastify";
import { login, sync, syncIcal } from "@uni/lms";
import { indexAll } from "@uni/ai";

export async function registerLmsRoutes(app: FastifyInstance): Promise<void> {
  // Opens a browser window for a one-time login. Long-running (waits for login).
  app.post("/api/lms/login", async () => {
    return login();
  });

  // Full headless sync: scrape LMS + pull iCal + reconcile, then refresh the
  // search index so the study chat can answer from the latest content.
  app.post("/api/lms/sync", async () => {
    const r = await sync();
    try {
      indexAll();
    } catch {
      /* non-fatal */
    }
    return r;
  });

  // Pull just the iCal deadline feed (fast; no browser needed).
  app.post("/api/lms/sync-ical", async () => {
    const { events } = await syncIcal();
    return { ok: true, counts: { events } };
  });
}
