import { createHash } from "node:crypto";
import { getDb, getSetting, setSetting } from "@uni/db";

// Google Calendar (OAuth "installed app" flow with loopback redirect).
//
// The full calendar scope (not just calendar.events) is what lets us create a
// dedicated "Uni Study" calendar, so deadlines can be toggled off in one click
// instead of being scattered through the student's personal calendar.
const SCOPE = "https://www.googleapis.com/auth/calendar";

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET ?? "";
const PORT = () => process.env.PORT ?? "8787";
const REDIRECT = () => `http://127.0.0.1:${PORT()}/api/gcal/callback`;

const CALENDAR_NAME = "Uni Study";

export function googleConfigured(): boolean {
  return Boolean(CLIENT_ID() && CLIENT_SECRET());
}
export function googleConnected(): boolean {
  return Boolean(getSetting("gcal_refresh_token"));
}

/** Consent URL the user opens to authorise calendar writes. */
export function authUrl(): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID());
  u.searchParams.set("redirect_uri", REDIRECT());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Exchange the auth code for tokens and store the refresh token locally. */
export async function handleCallback(code: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      redirect_uri: REDIRECT(),
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`Google token: ${json.error_description ?? json.error}`);
  if (json.refresh_token) setSetting("gcal_refresh_token", json.refresh_token);
}

async function accessToken(): Promise<string> {
  const refresh = getSetting("gcal_refresh_token");
  if (!refresh) throw new Error("Google Calendar not connected.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`Google refresh: ${json.error_description ?? json.error}`);
  return json.access_token as string;
}

interface GoogleFetchOpts {
  method?: string;
  body?: unknown;
  token: string;
}

async function gcal<T = any>(path: string, opts: GoogleFetchOpts): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method: opts.method ?? "GET",
    headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json?.error?.message ?? `Google returned ${res.status}`);
  return json as T;
}

/**
 * Which calendar to write to. Default is a dedicated "Uni Study" calendar,
 * created on first sync; `gcal_calendar_id` = "primary" opts back into the
 * student's main calendar.
 */
async function targetCalendar(token: string): Promise<string> {
  const configured = getSetting("gcal_calendar_id");
  if (configured) {
    if (configured === "primary") return "primary";
    // Confirm it still exists — a deleted calendar would fail on every event.
    const ok = await gcal(`/calendars/${encodeURIComponent(configured)}`, { token }).catch(() => null);
    if (ok) return configured;
  }

  const list = await gcal<{ items: { id: string; summary: string }[] }>(
    "/users/me/calendarList",
    { token },
  ).catch(() => ({ items: [] as { id: string; summary: string }[] }));
  const found = list.items?.find((c) => c.summary === CALENDAR_NAME);
  if (found) {
    setSetting("gcal_calendar_id", found.id);
    return found.id;
  }

  const made = await gcal<{ id: string }>("/calendars", {
    token,
    method: "POST",
    body: { summary: CALENDAR_NAME, description: "Deadlines and classes synced from Uni Study." },
  });
  setSetting("gcal_calendar_id", made.id);
  return made.id;
}

export interface PushResult {
  pushed: number;
  removed: number;
  calendarId: string;
}

/** Google's fixed palette. Deadlines red, exams purple, classes blue-grey. */
const COLOR: Record<string, string> = { deadline: "11", exam: "3", open: "8", class: "9", personal: "2" };

/**
 * Sync deadlines (and optionally classes and personal commitments) into Google
 * Calendar with a reminder N days before, from the reminder_days setting.
 *
 * Deterministic event ids mean a re-sync updates in place, and anything we
 * pushed previously that no longer exists locally is deleted — so a cancelled
 * assessment doesn't haunt the calendar forever.
 */
export async function pushToGoogleCalendar(): Promise<PushResult> {
  const token = await accessToken();
  const calendarId = await targetCalendar(token);
  const reminderDays = Number(getSetting("reminder_days") ?? "3");
  const reminderMin = Math.max(0, Math.round(reminderDays * 24 * 60));
  const includeClasses = getSetting("gcal_include_classes") === "true";
  const includePersonal = getSetting("gcal_include_personal") === "true";

  const kinds = ["deadline", "exam", "open"];
  if (includeClasses) kinds.push("class");
  if (includePersonal) kinds.push("personal");

  const events = getDb()
    .prepare(
      `SELECT e.id, e.title, e.kind, e.start_at, e.end_at, e.url, e.location, c.code AS course_code
       FROM events e LEFT JOIN courses c ON c.id = e.course_id
       WHERE e.kind IN (${kinds.map(() => "?").join(",")})
         AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))`,
    )
    .all(...kinds) as EventRow[];

  const previous = new Set<string>(readPushed());
  const current = new Set<string>();
  let pushed = 0;

  for (const e of events) {
    const id = gid(e.id);
    current.add(id);
    const start = new Date(e.start_at);
    // A deadline is a moment, not a meeting — give it a 30-minute block so it
    // shows as a labelled item rather than a hairline at the top of the day.
    const end = e.end_at ? new Date(e.end_at) : new Date(start.getTime() + 30 * 60_000);
    const isDeadline = e.kind === "deadline" || e.kind === "exam";
    const body = {
      id,
      summary: e.course_code && isDeadline ? `${e.course_code}: ${strip(e.title)}` : strip(e.title),
      description: [e.url, "Synced from Uni Study"].filter(Boolean).join("\n"),
      location: e.location ?? undefined,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      colorId: COLOR[e.kind] ?? undefined,
      reminders: isDeadline
        ? { useDefault: false, overrides: dedupeReminders([reminderMin, 24 * 60]) }
        : { useDefault: true },
    };

    try {
      await gcal(`/calendars/${encodeURIComponent(calendarId)}/events/${id}`, {
        token,
        method: "PUT",
        body,
      });
      pushed++;
    } catch {
      // Not there yet (or previously cancelled) — insert instead.
      try {
        await gcal(`/calendars/${encodeURIComponent(calendarId)}/events`, {
          token,
          method: "POST",
          body,
        });
        pushed++;
      } catch {
        /* one bad event shouldn't abort the sync */
      }
    }
  }

  let removed = 0;
  for (const id of previous) {
    if (current.has(id)) continue;
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
    ).catch(() => null);
    if (res && (res.ok || res.status === 404 || res.status === 410)) removed++;
  }

  writePushed([...current]);
  setSetting("gcal_last_push", new Date().toISOString());
  return { pushed, removed, calendarId };
}

/** Google rejects duplicate reminder overrides and caps them at 5. */
function dedupeReminders(minutes: number[]): { method: string; minutes: number }[] {
  return [...new Set(minutes.filter((m) => m >= 0))]
    .sort((a, b) => b - a)
    .slice(0, 5)
    .map((m) => ({ method: "popup", minutes: m }));
}

function readPushed(): string[] {
  try {
    const raw = getSetting("gcal_pushed_ids");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function writePushed(ids: string[]): void {
  setSetting("gcal_pushed_ids", JSON.stringify(ids));
}

const strip = (title: string) => title.replace(/^(Due|Opens):\s*/i, "");

/**
 * Deterministic Google event id. Google requires base32hex (0-9, a-v) and a
 * minimum length of 5, which a sha1 hex digest satisfies apart from w-z — hex
 * never produces those.
 */
function gid(ourId: string): string {
  return createHash("sha1").update(ourId).digest("hex");
}

type EventRow = {
  id: string;
  title: string;
  kind: string;
  start_at: string;
  end_at: string | null;
  url: string | null;
  location: string | null;
  course_code: string | null;
}
