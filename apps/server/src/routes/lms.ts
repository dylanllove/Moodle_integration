import type { FastifyInstance } from "fastify";
import { login, sync, syncIcal } from "@uni/lms";

export async function registerLmsRoutes(app: FastifyInstance): Promise<void> {
  // Opens a browser window for a one-time login. Long-running (waits for login).
  app.post("/api/lms/login", async () => {
    return login();
  });

  // Full headless sync: scrape LMS + pull iCal + reconcile.
  app.post("/api/lms/sync", async () => {
    return sync();
  });

  // Pull just the iCal deadline feed (fast; no browser needed).
  app.post("/api/lms/sync-ical", async () => {
    const { events } = await syncIcal();
    return { ok: true, counts: { events } };
  });
}
