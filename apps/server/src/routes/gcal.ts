import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@uni/db";
import {
  authUrl,
  handleCallback,
  googleConfigured,
  googleConnected,
  pushToGoogleCalendar,
} from "../google.js";

export async function registerGcalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/gcal/status", async () => ({
    configured: googleConfigured(),
    connected: googleConnected(),
  }));

  app.get("/api/gcal/auth", async (_req, reply) => {
    if (!googleConfigured())
      return reply.code(400).send({ error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env." });
    return { url: authUrl() };
  });

  // Google redirects the browser here after consent.
  app.get<{ Querystring: { code?: string; error?: string } }>(
    "/api/gcal/callback",
    async (req, reply) => {
      reply.header("content-type", "text/html");
      if (req.query.error) return page(`Authorisation failed: ${req.query.error}`);
      if (!req.query.code) return page("No authorisation code received.");
      try {
        await handleCallback(req.query.code);
        return page("✅ Google Calendar connected. You can close this tab and return to Uni Study.");
      } catch (e) {
        return page(`Error: ${String(e)}`);
      }
    },
  );

  app.post("/api/gcal/push", async (_req, reply) => {
    if (!googleConnected()) return reply.code(400).send({ error: "Not connected." });
    try {
      return { ok: true, ...(await pushToGoogleCalendar()) };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    }
  });

  app.post("/api/gcal/disconnect", async () => {
    setSetting("gcal_refresh_token", "");
    return { ok: true };
  });

  // Reminder lead-time setting (days before due).
  app.get("/api/settings/reminder-days", async () => ({
    days: Number(getSetting("reminder_days") ?? "3"),
  }));
  app.put<{ Body: { days: number } }>("/api/settings/reminder-days", async (req) => {
    setSetting("reminder_days", String(Math.max(0, Math.round(req.body.days))));
    return { ok: true };
  });
}

function page(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa"><div style="text-align:center"><h2>${msg}</h2></div></body>`;
}
