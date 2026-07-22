import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";
import type { CalEvent } from "@uni/db";

/**
 * Calendar endpoints. Besides the JSON feed (in core.ts), this exposes a
 * subscribable .ics feed so the user can add one clean, deduped "Uni" calendar
 * to Google Calendar / Apple Calendar (Settings → Add calendar → From URL) —
 * no OAuth required.
 */
export async function registerCalendarRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/calendar.ics", async (_req, reply) => {
    const events = getDb()
      .prepare("SELECT * FROM events ORDER BY start_at")
      .all() as unknown as CalEvent[];
    reply.header("content-type", "text/calendar; charset=utf-8");
    reply.header("content-disposition", 'inline; filename="uni-study.ics"');
    return buildIcs(events);
  });
}

function buildIcs(events: CalEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Uni Study//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Uni Study",
  ];
  for (const e of events) {
    const start = toIcsDate(e.start_at);
    const end = toIcsDate(e.end_at ?? e.start_at);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@uni-study`,
      `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeIcs(e.title)}`,
      e.url ? `URL:${escapeIcs(e.url)}` : "",
      `CATEGORIES:${e.kind}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n");
}

function toIcsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeIcs(s: string): string {
  return s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}
