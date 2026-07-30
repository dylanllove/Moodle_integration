import type { FastifyInstance } from "fastify";
import { getSetting } from "@uni/db";
import { runDigest } from "./digest.js";

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
