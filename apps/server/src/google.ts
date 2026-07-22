import { createHash } from "node:crypto";
import { getDb, getSetting, setSetting } from "@uni/db";

// Google Calendar (OAuth "installed app" flow with loopback redirect).
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET ?? "";
const PORT = () => process.env.PORT ?? "8787";
const REDIRECT = () => `http://127.0.0.1:${PORT()}/api/gcal/callback`;

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

export interface PushResult {
  pushed: number;
}

/**
 * Upsert active-course deadline + opening events into the user's primary Google
 * Calendar, with a reminder N days before (from the reminder_days setting).
 * Uses a deterministic event id so re-syncs update rather than duplicate.
 */
export async function pushToGoogleCalendar(): Promise<PushResult> {
  const token = await accessToken();
  const calendarId = getSetting("gcal_calendar_id") || "primary";
  const reminderDays = Number(getSetting("reminder_days") ?? "3");
  const reminderMin = Math.max(0, Math.round(reminderDays * 24 * 60));

  const events = getDb()
    .prepare(
      `SELECT e.* FROM events e
       WHERE (e.source = 'assignment' OR e.kind IN ('deadline','open','exam'))
         AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))`,
    )
    .all() as {
    id: string;
    title: string;
    start_at: string;
    url: string | null;
  }[];

  let pushed = 0;
  for (const e of events) {
    const start = new Date(e.start_at);
    const end = new Date(start.getTime() + 30 * 60_000);
    const body = {
      id: gid(e.id),
      summary: e.title,
      description: e.url ? `From Uni Study\n${e.url}` : "From Uni Study",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: reminderMin }] },
    };
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    // Try update; if it doesn't exist yet, insert.
    let r = await fetch(`${base}/${body.id}`, { method: "PUT", headers, body: JSON.stringify(body) });
    if (r.status === 404 || r.status === 410) {
      r = await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
    }
    if (r.ok) pushed++;
  }
  return { pushed };
}

/** Deterministic Google event id (base32hex-safe): sha1 hex of our event id. */
function gid(ourId: string): string {
  return createHash("sha1").update(ourId).digest("hex");
}
