import { getDb, getSetting, setSetting } from "@uni/db";
import { openContext, looksLoggedIn, detectLms } from "./session.js";
import { scrapeMoodle, type ScrapeCounts } from "./moodle.js";
import { scrapeBlackboard } from "./blackboard.js";
import { syncIcal } from "./ical.js";
import { moodleApiConfigured, syncMoodleApi } from "./moodle-api.js";
import { syncTimetable } from "./timetable.js";

export interface LoginResult {
  ok: boolean;
  error?: string;
}

/**
 * Open a real browser window at the LMS so the user can log in once (handling
 * SSO/2FA themselves). Cookies persist to the profile dir, so later syncs run
 * headless. Resolves when a session cookie appears or the user closes the window.
 */
export async function login(): Promise<LoginResult> {
  const base = getSetting("lms_url");
  if (!base) return { ok: false, error: "Set your LMS URL in Settings first." };

  const ctx = await openContext(false);
  let closedByUser = false;
  ctx.on("close", () => (closedByUser = true));

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    // Poll for up to 5 minutes for a login to complete.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && !closedByUser) {
      if (await looksLoggedIn(ctx)) {
        await ctx.close();
        return { ok: true };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!closedByUser) await ctx.close();
    return closedByUser
      ? { ok: true } // user closed the window after logging in
      : { ok: false, error: "Timed out waiting for login." };
  } catch (e) {
    if (!closedByUser) await ctx.close().catch(() => {});
    return { ok: false, error: String(e) };
  }
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  counts?: ScrapeCounts & { events: number; classes?: number };
}

/** Run a full sync. Prefers the Moodle Web Services API (token) and falls back
 * to browser scraping + iCal when no token is configured. */
export async function sync(): Promise<SyncResult> {
  // Preferred path: official Moodle API via token (reliable, no browser).
  if (moodleApiConfigured()) {
    try {
      const c = await syncMoodleApi();
      // Pull the iCal feed too if the user configured one (extra events).
      const ical = getSetting("ical_url") ? await syncIcal() : { events: 0 };
      // Pull the class timetable (configured URL/path, or an auto-detected .ics).
      const tt = await syncTimetable().catch(() => ({ classes: 0 }));
      setSetting("last_synced", new Date().toISOString());
      return {
        ok: true,
        counts: {
          courses: c.courses,
          assignments: c.assignments,
          lectures: c.lectures,
          events: c.events + ical.events,
          classes: tt.classes,
        },
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const base = getSetting("lms_url");
  if (!base) return { ok: false, error: "Set your LMS URL in Settings, or add a MOODLE_TOKEN to .env." };

  const ctx = await openContext(true);
  try {
    if (!(await looksLoggedIn(ctx))) {
      await ctx.close();
      return { ok: false, error: "Not logged in. Click 'Connect LMS' and log in first." };
    }

    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    const kind = await detectLms(page);
    await page.close();

    let counts: ScrapeCounts = { courses: 0, assignments: 0, lectures: 0 };
    if (kind === "moodle") counts = await scrapeMoodle(ctx, base);
    else if (kind === "blackboard") counts = await scrapeBlackboard(ctx, base);
    // For "unknown" we still run iCal below so deadlines work.

    await ctx.close();

    const { events } = await syncIcal();
    reconcileDueDates();
    materialiseAssignmentEvents();

    return { ok: true, counts: { ...counts, events } };
  } catch (e) {
    await ctx.close().catch(() => {});
    return { ok: false, error: String(e) };
  }
}

/** Fill missing assignment due dates by matching titles against iCal events. */
function reconcileDueDates(): void {
  const db = getDb();
  const open = db
    .prepare("SELECT id, title FROM assignments WHERE due_at IS NULL")
    .all() as { id: string; title: string }[];
  const events = db
    .prepare("SELECT title, start_at FROM events WHERE source = 'ical'")
    .all() as { title: string; start_at: string }[];
  for (const a of open) {
    const key = a.title.toLowerCase().slice(0, 24);
    const hit = events.find((e) => e.title.toLowerCase().includes(key) || key.includes(e.title.toLowerCase().slice(0, 24)));
    if (hit) db.prepare("UPDATE assignments SET due_at = ? WHERE id = ?").run(hit.start_at, a.id);
  }
}

/** Ensure every assignment with a due date shows up on the calendar. */
function materialiseAssignmentEvents(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, course_id, title, url, due_at FROM assignments WHERE due_at IS NOT NULL")
    .all() as { id: string; course_id: string | null; title: string; url: string | null; due_at: string }[];
  for (const a of rows) {
    db.prepare(
      `INSERT INTO events (id, course_id, title, kind, source, start_at, url)
       VALUES (?, ?, ?, 'deadline', 'assignment', ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, start_at=excluded.start_at, updated_at=datetime('now')`,
    ).run("assign-evt:" + a.id, a.course_id, "Due: " + a.title, a.due_at, a.url);
  }
}
