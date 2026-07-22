import ical from "node-ical";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getSetting, upsert } from "@uni/db";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface TimetableResult {
  classes: number;
  source?: string;
}

/** Load the iCal feed from a URL or a local file (auto-detected if unset). */
async function loadFeed(): Promise<{ data: Record<string, ical.CalendarComponent>; source: string } | null> {
  const configured = getSetting("timetable_url");

  if (configured && /^https?:\/\//i.test(configured)) {
    return { data: await ical.async.fromURL(configured), source: configured };
  }

  // A configured local path, else auto-detect a .ics dropped in the repo root.
  let path: string | null = null;
  if (configured) path = isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
  else {
    const ics = readdirSync(REPO_ROOT).filter((f) => f.toLowerCase().endsWith(".ics"));
    if (ics.length) path = join(REPO_ROOT, ics[0]!);
  }
  if (!path) return null;
  return { data: ical.sync.parseICS(readFileSync(path, "utf8")), source: path };
}

/**
 * Ingest a university timetable (URL or local .ics) into calendar events.
 * Recurring classes are expanded; rooms and the detail line (activity type,
 * staff, compulsory "(C)") are preserved for the calendar and the chatbot.
 */
export async function syncTimetable(): Promise<TimetableResult> {
  const feed = await loadFeed();
  if (!feed) return { classes: 0 };

  const db = getDb();
  const rangeStart = new Date(Date.now() - 7 * 864e5);
  const rangeEnd = new Date(Date.now() + 16 * 7 * 864e5);
  db.prepare("DELETE FROM events WHERE source = 'timetable'").run();

  let classes = 0;
  for (const key of Object.keys(feed.data)) {
    const c = feed.data[key] as ical.CalendarComponent & {
      rrule?: { between: (a: Date, b: Date, inc?: boolean) => Date[] };
      exdate?: Record<string, unknown>;
      location?: string;
      description?: string;
    };
    if (c.type !== "VEVENT" || !c.start) continue;

    const durMs = c.end ? new Date(c.end).getTime() - new Date(c.start).getTime() : 60 * 60_000;
    const summary = cleanTitle((c.summary as string) || "Class");
    const location = c.location || null;
    const notes = (c.description as string)?.replace(/\r?\n/g, " · ").trim() || null;
    const uid = (c.uid as string) || key;

    const occurrences: Date[] = [];
    if (c.rrule) {
      const ex = c.exdate
        ? Object.values(c.exdate).map((d) => new Date(d as string | number | Date).getTime())
        : [];
      for (const d of c.rrule.between(rangeStart, rangeEnd, true)) {
        if (!ex.includes(d.getTime())) occurrences.push(d);
      }
    } else {
      const s = new Date(c.start);
      if (s >= rangeStart && s <= rangeEnd) occurrences.push(s);
    }

    for (const occ of occurrences) {
      const start = new Date(occ);
      const end = new Date(occ.getTime() + durMs);
      const id = `tt:${sha(uid)}:${start.toISOString().slice(0, 16)}`;
      upsert(
        "events",
        {
          id,
          course_id: matchCourse(`${summary} ${notes ?? ""}`, location),
          title: summary,
          kind: "class",
          source: "timetable",
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          url: null,
          location,
          notes,
        },
        ["course_id", "title", "kind", "source", "start_at", "end_at", "url", "location", "notes"],
      );
      classes++;
    }
  }
  return { classes, source: feed.source };
}

/** Tidy the raw SUMMARY (e.g. "Intro to CS, ComA" → "Intro to CS (ComA)"). */
function cleanTitle(s: string): string {
  const m = s.match(/^(.*),\s*([A-Za-z]{3}[A-Z])$/);
  return m ? `${m[1]!.trim()} (${activityLabel(m[2]!)})` : s;
}

function activityLabel(code: string): string {
  const kind = code.slice(0, 3).toLowerCase();
  return (
    { lec: "Lecture", tut: "Tutorial", lab: "Lab", com: "Computer lab", wor: "Workshop", tes: "Test" }[
      kind
    ] ?? code
  ) + ` ${code.slice(3)}`;
}

function matchCourse(text: string, location?: string | null): string | null {
  const hay = `${text} ${location ?? ""}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const courses = getDb()
    .prepare("SELECT id, name, code FROM courses")
    .all() as { id: string; name: string; code: string | null }[];
  for (const c of courses) {
    const core = (c.code ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 7);
    if (core && hay.includes(core)) return c.id;
    if (c.name && hay.includes(c.name.replace(/[^a-z0-9]/gi, "").toLowerCase())) return c.id;
  }
  return null;
}
