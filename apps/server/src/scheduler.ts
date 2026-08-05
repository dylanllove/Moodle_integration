import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@uni/db";
import { runDigest } from "./digest.js";
import { runFullSync, syncRunning } from "./sync-job.js";

/**
 * Weekly digest scheduler.
 *
 * A local app can't rely on being awake at 19:00 on Sunday, so this doesn't try
 * to fire on the minute. It ticks every ten minutes and asks "has the most
 * recent scheduled slot passed, and have we sent that week's digest?" — which
 * means a laptop that was shut on Sunday night still gets the digest when it
 * opens on Monday, and never sends the same week twice.
 */
const TICK_MS = 10 * 60_000;
/** How long after a missed slot we'll still catch up. Beyond this it's stale. */
const CATCHUP_DAYS = 3;

export function startScheduler(app: FastifyInstance): void {
  const tick = () => {
    void maybeRun(app);
  };
  // A first check shortly after boot catches the "was off on Sunday" case.
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, TICK_MS).unref?.();
  startAutoSync(app);
}

/* --- Continuous sync ------------------------------------------------------- */

/** How often to pull everything again, unless the student changes it. */
const DEFAULT_SYNC_MINUTES = 20;
/** How often to touch Echo360 so its session cookies never go stale. */
const KEEPALIVE_MS = 10 * 60_000;
/**
 * A tick this much later than scheduled means the machine was asleep. Waking to
 * a stale app is the exact moment a re-sync is most useful, so don't wait out
 * the rest of the interval.
 */
const SLEEP_GAP_MS = 3 * 60_000;

let expectedAt: number | null = null;

/** When the next automatic sync is due — null if auto-sync isn't running. */
export function nextAutoSyncAt(): string | null {
  return expectedAt == null ? null : new Date(expectedAt).toISOString();
}

export function autoSyncSettings(): { enabled: boolean; minutes: number; nextAt: string | null } {
  return {
    enabled: getSetting("auto_sync_enabled") !== "false",
    minutes: syncIntervalMs() / 60_000,
    nextAt: nextAutoSyncAt(),
  };
}

/**
 * Keep the app current while it's open.
 *
 * Syncing only at launch means a laptop that stays open all day — which is what
 * a laptop does during a teaching day — shows you this morning's picture at 4pm.
 * Deadlines move, lectures publish an hour after the class, announcements go up.
 * This re-runs the same pipeline on a timer, skips its turn if a sync is already
 * going, and treats waking from sleep as a reason to run now.
 */
export function startAutoSync(app: FastifyInstance): void {
  expectedAt = Date.now() + syncIntervalMs();

  const tick = async () => {
    const now = Date.now();
    const overslept = expectedAt != null && now - expectedAt > SLEEP_GAP_MS;
    expectedAt = now + syncIntervalMs();
    if (getSetting("auto_sync_enabled") === "false") return;
    if (syncRunning()) return;
    if (overslept) app.log.info("Auto-sync: catching up after the machine was asleep.");
    try {
      const state = await runFullSync(app);
      setSetting("last_auto_sync", new Date().toISOString());
      const failed = state.phases.filter((p) => p.status === "error").map((p) => p.key);
      app.log.info(failed.length ? `Auto-sync done (failed: ${failed.join(", ")})` : "Auto-sync done");
    } catch (e) {
      app.log.warn(`Auto-sync: ${String(e)}`);
    }
  };

  // Checked on a fixed short interval rather than scheduled at the full
  // interval, so a machine that slept through its slot notices on waking.
  const CHECK_MS = 60_000;
  setInterval(() => {
    if (expectedAt != null && Date.now() >= expectedAt - 1000) void tick();
  }, CHECK_MS).unref?.();

  startEchoKeepalive(app);
}

function syncIntervalMs(): number {
  const raw = Number(getSetting("auto_sync_minutes"));
  const minutes = Number.isFinite(raw) && raw >= 5 ? Math.min(raw, 24 * 60) : DEFAULT_SYNC_MINUTES;
  return minutes * 60_000;
}

/**
 * Echo360's cookies — including the CloudFront signed set that authorises
 * playback — carry no expiry date. They're session cookies that go stale
 * server-side once the session sits idle, and are reissued on any authenticated
 * request. Touching the site every ten minutes and saving what comes back is
 * what turns "log in each week" into "log in once".
 */
function startEchoKeepalive(app: FastifyInstance): void {
  const ping = async () => {
    if (syncRunning()) return; // a sync is already exercising the session
    try {
      const { echoConnected } = await import("@uni/lms");
      if (!echoConnected()) return;
      // Through the route so the health bookkeeping lives in exactly one place.
      const res = await app.inject({ method: "POST", url: "/api/echo360/keepalive" });
      const body = JSON.parse(res.body || "{}") as { ok?: boolean; reason?: string };
      if (!body.ok) app.log.warn(`Echo360 keepalive: ${body.reason ?? "failed"}`);
    } catch (e) {
      app.log.warn(`Echo360 keepalive: ${String(e)}`);
    }
  };
  setTimeout(() => void ping(), 90_000).unref?.();
  setInterval(() => void ping(), KEEPALIVE_MS).unref?.();
}

async function maybeRun(app: FastifyInstance): Promise<void> {
  try {
    if (getSetting("digest_enabled") !== "true") return;
    const slot = lastScheduledSlot(new Date());
    if (Date.now() - slot.getTime() > CATCHUP_DAYS * 864e5) return;

    const appUrl = getSetting("app_url") || "http://localhost:5173";
    const r = await runDigest(appUrl);
    if (r.channel === "skipped") return;
    app.log.info(
      r.sent
        ? `Weekly digest sent for week of ${r.weekStart}`
        : `Weekly digest built for week of ${r.weekStart} but not emailed: ${r.error}`,
    );
  } catch (e) {
    app.log.warn(`Digest scheduler: ${String(e)}`);
  }
}

/** The most recent occurrence of the configured day/time, at or before `now`. */
export function lastScheduledSlot(now: Date): Date {
  const day = clampInt(getSetting("digest_day"), 0, 6, 0); // 0 = Sunday
  const hour = clampInt(getSetting("digest_hour"), 0, 23, 19);
  const minute = clampInt(getSetting("digest_minute"), 0, 59, 0);

  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  // Walk back to the configured weekday; if that's today but the time hasn't
  // arrived, step back a full week.
  const backDays = (now.getDay() - day + 7) % 7;
  slot.setDate(slot.getDate() - backDays);
  if (slot > now) slot.setDate(slot.getDate() - 7);
  return slot;
}

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  // An unset setting must fall back, not coerce: Number(null) and Number("")
  // are both 0, which would silently reschedule the digest to midnight.
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}
