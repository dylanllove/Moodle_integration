import ical from "node-ical";
import { createHash } from "node:crypto";
import { getDb, getSetting, upsert } from "@uni/db";

export interface IcalResult {
  events: number;
}

/**
 * Fetch and parse the LMS iCal export feed (the token is embedded in the URL,
 * so this needs no browser session) and upsert deadline events.
 *
 * This is the reliable deadline path for BOTH Moodle and Blackboard — it works
 * even when page scraping doesn't.
 */
export async function syncIcal(icalUrl?: string): Promise<IcalResult> {
  const url = icalUrl ?? getSetting("ical_url");
  if (!url) return { events: 0 };

  const data = await ical.async.fromURL(url);
  const db = getDb();
  let count = 0;

  for (const key of Object.keys(data)) {
    const c = data[key] as ical.CalendarComponent;
    if (c.type !== "VEVENT" || !c.start) continue;

    const uid = (c.uid as string) || key;
    const id = "ical:" + createHash("sha1").update(uid).digest("hex").slice(0, 16);
    const start = new Date(c.start).toISOString();
    const end = c.end ? new Date(c.end).toISOString() : null;
    const summary = (c.summary as string) || "(untitled)";

    upsert(
      "events",
      {
        id,
        course_id: matchCourse(summary, c.description as string | undefined),
        title: summary,
        kind: classify(summary, (c as { categories?: string[] }).categories),
        source: "ical",
        start_at: start,
        end_at: end,
        url: (c.url as string) || null,
      },
      ["course_id", "title", "kind", "source", "start_at", "end_at", "url"],
    );
    count++;
  }

  return { events: count };
}

function classify(summary: string, categories?: string[]): string {
  const s = (summary + " " + (categories ?? []).join(" ")).toLowerCase();
  if (/(exam|final|midterm|test)/.test(s)) return "exam";
  if (/(assignment|assessment|submission|due|quiz|report|essay)/.test(s)) return "deadline";
  if (/(lecture|tutorial|lab|seminar|class)/.test(s)) return "class";
  return "deadline";
}

/** Best-effort: link an event to a known course by matching its code/name. */
function matchCourse(summary: string, description?: string): string | null {
  const haystack = (summary + " " + (description ?? "")).toLowerCase();
  const courses = getDb()
    .prepare("SELECT id, name, code FROM courses")
    .all() as { id: string; name: string; code: string | null }[];
  for (const c of courses) {
    if (c.code && haystack.includes(c.code.toLowerCase())) return c.id;
    if (c.name && haystack.includes(c.name.toLowerCase())) return c.id;
  }
  return null;
}
