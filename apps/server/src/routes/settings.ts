import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@uni/db";

/** Keys the UI is allowed to read/write. API key stays server-side only. */
const PUBLIC_KEYS = ["lms_url", "ical_url", "timetable_url", "gcal_sync_enabled", "gcal_calendar_id"] as const;

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => {
    const out: Record<string, string | null> = {};
    for (const k of PUBLIC_KEYS) out[k] = getSetting(k);
    // Report whether keys are configured, without exposing them.
    out.has_api_key = process.env.OPENAI_API_KEY ? "true" : "false";
    out.has_moodle_token = process.env.MOODLE_TOKEN && process.env.MOODLE_URL ? "true" : "false";
    return out;
  });

  app.put<{ Body: Record<string, string> }>("/api/settings", async (req) => {
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if ((PUBLIC_KEYS as readonly string[]).includes(k)) setSetting(k, String(v));
    }
    return { ok: true };
  });
}
