import type { FastifyInstance } from "fastify";
import { getDb, getSetting } from "@uni/db";

/**
 * The subscribable calendar feed.
 *
 * This is how Apple Calendar (and any other client) gets deadlines: Apple has no
 * write API that doesn't involve storing an Apple ID, so a `webcal://`
 * subscription is both the standard route and the one that keeps working when
 * the app isn't running — the calendar app re-fetches on its own schedule.
 *
 * Google can also subscribe here instead of using OAuth, which is why the feed
 * carries real alarms rather than leaving reminders to the client's defaults.
 */
const ALL_KINDS = ["deadline", "exam", "open", "class", "personal"] as const;

export async function registerCalendarRoutes(app: FastifyInstance): Promise<void> {
  /**
   * `?kinds=deadline,exam` narrows the feed — a student who already has their
   * timetable in Apple Calendar doesn't want it twice.
   */
  app.get<{ Querystring: { kinds?: string; all?: string } }>("/api/calendar.ics", async (req, reply) => {
    const kinds = parseKinds(req.query.kinds);
    const activeOnly = req.query.all !== "1";
    const rows = getDb()
      .prepare(
        `SELECT e.id, e.title, e.kind, e.start_at, e.end_at, e.url, e.location, e.notes,
                c.code AS course_code, c.name AS course_name
         FROM events e LEFT JOIN courses c ON c.id = e.course_id
         WHERE e.kind IN (${kinds.map(() => "?").join(",")})
           ${activeOnly ? "AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))" : ""}
         ORDER BY e.start_at`,
      )
      .all(...kinds) as IcsRow[];

    reply.header("content-type", "text/calendar; charset=utf-8");
    reply.header("content-disposition", 'inline; filename="uni-study.ics"');
    // Discourage a stale cache: deadlines move.
    reply.header("cache-control", "no-cache, max-age=0");
    return buildIcs(rows, Number(getSetting("reminder_days") ?? "3"));
  });

  /** The links the Settings page offers for Apple/Google/Outlook subscription. */
  app.get("/api/calendar/subscribe", async (req) => {
    const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? 8787}`;
    const path = "/api/calendar.ics";
    return {
      https: `http://${host}${path}`,
      webcal: `webcal://${host}${path}`,
      kinds: ALL_KINDS,
      counts: kindCounts(),
    };
  });
}

function parseKinds(raw?: string): string[] {
  if (!raw) return [...ALL_KINDS];
  const asked = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((k) => (ALL_KINDS as readonly string[]).includes(k));
  return asked.length ? asked : [...ALL_KINDS];
}

function kindCounts(): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM events
       WHERE course_id IS NULL OR course_id IN (SELECT id FROM courses WHERE active = 1)
       GROUP BY kind`,
    )
    .all() as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

function buildIcs(events: IcsRow[], reminderDays: number): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Uni Study//Deadlines//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Uni Study",
    "X-WR-CALDESC:Deadlines, exams, classes and commitments from Uni Study",
    // Both spellings: Apple honours the first, most others the second.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  const stamp = toIcsDate(new Date().toISOString());

  for (const e of events) {
    const start = new Date(e.start_at);
    const isMoment = e.kind === "deadline" || e.kind === "exam" || e.kind === "open";
    const end = e.end_at ? new Date(e.end_at) : new Date(start.getTime() + (isMoment ? 30 : 60) * 60_000);
    const title = e.title.replace(/^(Due|Opens):\s*/i, "");
    const prefix = e.course_code && isMoment ? `${e.course_code}: ` : "";

    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@uni-study`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsDate(start.toISOString())}`,
      `DTEND:${toIcsDate(end.toISOString())}`,
      `SUMMARY:${esc(prefix + title)}`,
      `CATEGORIES:${esc(labelFor(e.kind))}`,
      `TRANSP:${e.kind === "open" ? "TRANSPARENT" : "OPAQUE"}`,
    );
    const description = [
      e.course_name ? `Course: ${e.course_name}` : null,
      e.notes,
      e.url,
    ].filter(Boolean).join("\\n");
    if (description) lines.push(`DESCRIPTION:${esc(description, true)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.url) lines.push(`URL:${esc(e.url)}`);

    // Deadlines and exams get two nudges: the student's lead time, and the
    // morning before. Classes rely on the client's defaults.
    if (e.kind === "deadline" || e.kind === "exam") {
      for (const days of dedupe([Math.max(0, reminderDays), 1])) {
        lines.push(
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          `DESCRIPTION:${esc(title)}`,
          `TRIGGER:-P${days}D`,
          "END:VALARM",
        );
      }
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

const dedupe = (ns: number[]) => [...new Set(ns)].sort((a, b) => b - a);

const labelFor = (kind: string) =>
  ({ deadline: "Deadline", exam: "Exam", open: "Opens", class: "Class", personal: "Personal" })[kind] ??
  "Event";

function toIcsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** `keepBreaks` preserves the literal \n escapes already in a description. */
function esc(s: string, keepBreaks = false): string {
  const escaped = s.replace(/([,;\\])/g, "\\$1");
  return keepBreaks ? escaped.replace(/\\\\n/g, "\\n") : escaped.replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 caps a content line at 75 octets, continued with a leading space.
 * Apple Calendar is the strict one here: an over-long SUMMARY silently drops
 * the whole event.
 */
function fold(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, "utf8") > (out.length ? 74 : 75)) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out.join("\r\n ");
}

type IcsRow = {
  id: string;
  title: string;
  kind: string;
  start_at: string;
  end_at: string | null;
  url: string | null;
  location: string | null;
  notes: string | null;
  course_code: string | null;
  course_name: string | null;
}
