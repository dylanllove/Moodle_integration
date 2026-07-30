import { getDb, upsert } from "@uni/db";

/** How far ahead recurring commitments are expanded. Matches the timetable range. */
const HORIZON_WEEKS = 16;

export interface PersonalResult {
  occurrences: number;
}

/**
 * Expand the student's life outside class into calendar events.
 *
 * Everything downstream — the month/week calendar, the workload heatmap, the
 * .ics feed, the Sunday digest — reads `events`. So rather than teach each of
 * them about commitments, recurring patterns are materialised into events with
 * source='personal' here, and nothing else has to change.
 */
export function syncPersonal(): PersonalResult {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM commitments").all() as CommitmentRow[];

  db.prepare("DELETE FROM events WHERE source = 'personal'").run();

  const from = startOfDay(new Date(Date.now() - 7 * 864e5));
  const to = new Date(Date.now() + HORIZON_WEEKS * 7 * 864e5);
  let occurrences = 0;

  for (const c of rows) {
    const hours = c.hours > 0 ? c.hours : 1;
    const notes = c.notes || null;

    // One-off: a single dated commitment.
    if (c.start_at) {
      const start = new Date(c.start_at);
      if (start >= from && start <= to) {
        writeEvent(`personal:${c.id}`, c, start, hours, notes);
        occurrences++;
      }
      continue;
    }

    // Recurring: a set of weekdays at a time of day, optionally date-bounded.
    const weekdays = parseWeekdays(c.weekdays);
    if (!weekdays.length || !c.start_time) continue;
    const [h, min] = parseTime(c.start_time);
    const windowStart = c.from_date ? maxDate(from, startOfDay(new Date(c.from_date))) : from;
    const windowEnd = c.to_date ? minDate(to, endOfDay(new Date(c.to_date))) : to;

    for (const day = new Date(windowStart); day <= windowEnd; day.setDate(day.getDate() + 1)) {
      if (!weekdays.includes(day.getDay())) continue;
      const start = new Date(day);
      start.setHours(h, min, 0, 0);
      writeEvent(`personal:${c.id}:${dateKey(start)}`, c, start, hours, notes);
      occurrences++;
    }
  }

  return { occurrences };
}

function writeEvent(
  id: string,
  c: CommitmentRow,
  start: Date,
  hours: number,
  notes: string | null,
): void {
  upsert(
    "events",
    {
      id,
      course_id: null,
      title: c.title,
      kind: "personal",
      source: "personal",
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + hours * 3_600_000).toISOString(),
      url: null,
      location: null,
      // The kind is carried in notes so the calendar can colour it and the
      // heatmap can tell a work shift from a coffee.
      notes: [c.kind, notes].filter(Boolean).join(" · "),
    },
    ["course_id", "title", "kind", "source", "start_at", "end_at", "url", "location", "notes"],
  );
}

function parseWeekdays(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  } catch {
    return [];
  }
}

function parseTime(hhmm: string): [number, number] {
  const m = hhmm.match(/^(\d{1,2}):?(\d{2})?/);
  return [Math.min(23, Number(m?.[1] ?? 9)), Math.min(59, Number(m?.[2] ?? 0))];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
const maxDate = (a: Date, b: Date) => (a > b ? a : b);
const minDate = (a: Date, b: Date) => (a < b ? a : b);
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type CommitmentRow = {
  id: string;
  title: string;
  kind: string;
  weekdays: string | null;
  start_time: string | null;
  hours: number;
  start_at: string | null;
  from_date: string | null;
  to_date: string | null;
  notes: string | null;
}
