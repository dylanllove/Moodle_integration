import type { FastifyInstance } from "fastify";
import { getDb, getSetting, setSetting } from "@uni/db";
import {
  buildDigest,
  digestMarkdown,
  digestSubject,
  mailConfig,
  mailConfigured,
  runDigest,
  sendDigest,
} from "../digest.js";
import { lastScheduledSlot } from "../scheduler.js";
import { saveEnv } from "../env-file.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function registerDigestRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get("/api/digest/status", async () => {
    const cfg = mailConfig();
    const day = Number(getSetting("digest_day") ?? "0");
    const hour = Number(getSetting("digest_hour") ?? "19");
    const minute = Number(getSetting("digest_minute") ?? "0");
    const last = db
      .prepare("SELECT id, sent_at, channel, subject, error FROM digests ORDER BY id DESC LIMIT 1")
      .get() as
      | { id: string; sent_at: string | null; channel: string; subject: string; error: string | null }
      | undefined;

    return {
      enabled: getSetting("digest_enabled") === "true",
      emailConfigured: mailConfigured(),
      // Never echo the password back; the host/user are enough to show state.
      smtp: {
        host: process.env.SMTP_HOST ?? "",
        port: Number(process.env.SMTP_PORT ?? 587),
        user: process.env.SMTP_USER ?? "",
        hasPassword: Boolean(process.env.SMTP_PASS),
        from: process.env.SMTP_FROM ?? "",
      },
      to: getSetting("digest_email") ?? "",
      schedule: { day, hour, minute, label: `${DAYS[day] ?? "Sunday"} ${pad(hour)}:${pad(minute)}` },
      lastSlot: lastScheduledSlot(new Date()).toISOString(),
      last: last ?? null,
    };
  });

  /** Render the digest without sending — the honest way to preview a template. */
  app.get("/api/digest/preview", async () => {
    const d = buildDigest();
    return { subject: digestSubject(d), markdown: digestMarkdown(d), data: d };
  });

  /** Past digests, so a missed email isn't a lost one. */
  app.get("/api/digest/history", async () =>
    db.prepare("SELECT id, sent_at, channel, subject, body, error FROM digests ORDER BY id DESC LIMIT 12").all(),
  );

  app.post("/api/digest/send", async (req, reply) => {
    const appUrl = getSetting("app_url") || `http://${(req.headers.host ?? "localhost:5173").replace(/:\d+$/, ":5173")}`;
    const r = await runDigest(appUrl, { force: true });
    if (!r.sent) return reply.code(mailConfigured() ? 500 : 400).send({ ok: false, ...r });
    return { ok: true, ...r };
  });

  app.put<{
    Body: {
      enabled?: boolean;
      to?: string;
      day?: number;
      hour?: number;
      minute?: number;
      smtp?: { host?: string; port?: number; user?: string; pass?: string; from?: string };
    };
  }>("/api/digest/settings", async (req, reply) => {
    const b = req.body ?? {};

    if (b.smtp) {
      // Credentials live in .env next to the other secrets, not in the DB.
      const env: Record<string, string> = {};
      if (b.smtp.host !== undefined) env.SMTP_HOST = b.smtp.host.trim();
      if (b.smtp.port !== undefined) env.SMTP_PORT = String(b.smtp.port);
      if (b.smtp.user !== undefined) env.SMTP_USER = b.smtp.user.trim();
      if (b.smtp.pass) env.SMTP_PASS = b.smtp.pass;
      if (b.smtp.from !== undefined) env.SMTP_FROM = b.smtp.from.trim();
      if (Object.keys(env).length) saveEnv(env);
    }

    if (b.to !== undefined) {
      const to = b.to.trim();
      if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return reply.code(400).send({ error: "That doesn't look like an email address." });
      }
      setSetting("digest_email", to);
    }
    if (b.day !== undefined) setSetting("digest_day", String(clamp(b.day, 0, 6)));
    if (b.hour !== undefined) setSetting("digest_hour", String(clamp(b.hour, 0, 23)));
    if (b.minute !== undefined) setSetting("digest_minute", String(clamp(b.minute, 0, 59)));
    if (b.enabled !== undefined) {
      if (b.enabled && !mailConfigured()) {
        return reply.code(400).send({
          error: "Add your email details first — there's nowhere to send the digest yet.",
        });
      }
      setSetting("digest_enabled", b.enabled ? "true" : "false");
    }
    return { ok: true };
  });

  /** Verify SMTP by sending this week's digest to the configured address. */
  app.post("/api/digest/test", async (req, reply) => {
    if (!mailConfigured()) {
      return reply.code(400).send({ error: "Fill in the email settings first." });
    }
    const appUrl = getSetting("app_url") || "http://localhost:5173";
    const r = await sendDigest(buildDigest(), appUrl);
    if (!r.ok) return reply.code(500).send({ error: r.error });
    return { ok: true, to: r.to };
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
