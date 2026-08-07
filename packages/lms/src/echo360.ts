import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@uni/db";
import { openContext } from "./session.js";

const PROFILE = ".echo360-profile";
const ORIGIN = "https://echo360.net.au";
const CONTENT_RE = /content\.echo360\.[^/]+\/.+\.m3u8/i;
const LOGIN_URL_RE = /login\.echo360|\/login(\b|\/|\?)/i;
/** Anything the player fetches that could carry captions. */
const CAPTION_URL_RE = /transcript|caption|subtitle|\.vtt|\.srt/i;
const STATE_FILE = () => join(dataDir(), "echo-state.json");

// The headed login window (kept alive while open). Once the user has logged in
// we persist the session (cookies + localStorage) to STATE_FILE via
// `storageState`, so future launches can reuse it headlessly with no re-login.
let loginCtx: BrowserContext | null = null;
let lock: Promise<unknown> = Promise.resolve();

export function withEchoLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});
  return run as Promise<T>;
}

export interface EchoLesson {
  lessonId: string;
  mediaId: string | null;
  title: string;
  start: string | null;
  end: string | null;
}
export interface AudioManifest {
  url: string;
  headers: Record<string, string>;
}

export function echoHasSession(): boolean {
  return existsSync(STATE_FILE());
}

/** Connected if a login window is open OR we have a saved session to reuse. */
export function echoConnected(): boolean {
  return loginCtx != null || echoHasSession();
}

/**
 * Every Echo360 cookie is a *session* cookie with no expiry date — including the
 * CloudFront signed-cookie triple that authorises media playback. They don't
 * time out on a clock; they go stale server-side once the session sits idle, and
 * they're reissued on any authenticated request.
 *
 * So the way to never sign in again is not to store the session more carefully.
 * It's to keep using it: touch Echo360 on a schedule, and write the refreshed
 * cookies straight back to disk. A session that's exercised every twenty minutes
 * never gets the chance to idle out.
 */
export async function keepEchoSessionWarm(): Promise<{ ok: boolean; reason?: string }> {
  if (!echoConnected()) return { ok: false, reason: "not connected" };
  return withEchoLock(async () => {
    const acquired = await acquireEchoContext().catch(() => null);
    if (!acquired) return { ok: false, reason: "no usable session" };
    try {
      const live = await ensureEchoLoggedIn(acquired.ctx);
      // Persist either way: even a failed check may have rotated cookies, and
      // throwing those away would make the next attempt strictly worse.
      await persistEchoSession(acquired.ctx);
      return live.ok ? { ok: true } : { ok: false, reason: live.reason };
    } finally {
      await acquired.done();
    }
  });
}

/**
 * Confirm the context can reach an authenticated page, giving any single sign-on
 * round trip time to complete.
 *
 * The old check looked at the URL once, immediately after `networkidle`, and any
 * glimpse of a login URL was treated as a dead session — which then *deleted*
 * the saved credentials. But landing on the login host is exactly what a silent
 * re-auth looks like halfway through: the IdP bounces you and hands you back.
 * Only a login page that's still a login page after it has settled means the
 * session is genuinely gone.
 */
export async function ensureEchoLoggedIn(
  ctx: BrowserContext,
  attempts = 2,
): Promise<{ ok: boolean; reason?: string }> {
  const page = await ctx.newPage();
  try {
    for (let i = 0; i < attempts; i++) {
      await page
        .goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(() => {});
      // Let redirect chains and any auto-submitted SSO form run to the end.
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      if (!LOGIN_URL_RE.test(page.url())) return { ok: true };

      // Sitting on the login host: either mid-redirect, or a real form asking
      // for credentials. A visible password field settles which.
      const asksForCredentials = await page
        .locator('input[type="password"], input[name="password"]')
        .first()
        .isVisible({ timeout: 4000 })
        .catch(() => false);
      if (asksForCredentials) return { ok: false, reason: "ECHO_SESSION_EXPIRED" };
      await page.waitForTimeout(4000);
    }
    return LOGIN_URL_RE.test(page.url())
      ? { ok: false, reason: "ECHO_SESSION_EXPIRED" }
      : { ok: true };
  } catch (e) {
    // A network blip is not an expired session — say so, so nothing gets wiped.
    return { ok: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await page.close().catch(() => {});
  }
}

export function clearEchoSession(): void {
  try {
    if (existsSync(STATE_FILE())) rmSync(STATE_FILE());
  } catch {
    /* ignore */
  }
}

/**
 * Save the current session so it survives restarts.
 *
 * Written to a temporary file and renamed into place. The session is refreshed
 * from several directions now — every sync, every keepalive, every transcript
 * batch — and a half-written state file read by the next launch is exactly the
 * "log in again" this whole mechanism exists to prevent. Rename is atomic.
 */
export async function persistEchoSession(ctx: BrowserContext): Promise<void> {
  const target = STATE_FILE();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await ctx.storageState({ path: tmp });
    renameSync(tmp, target);
  } catch {
    try {
      if (existsSync(tmp)) rmSync(tmp);
    } catch {
      /* nothing more to do */
    }
  }
}

/**
 * Get a context to run Echo operations.
 *
 * The saved session is *always* preferred, because it runs headless. This used to
 * hand back the live login window whenever one existed, which meant that once
 * you'd connected Echo360 the window stayed open and every later sync drove it —
 * opening a tab per lecture, playing video, on top of whatever you were doing.
 * Background work should be invisible; the only reason to show a browser is to
 * let someone type a password into it.
 *
 * The live window remains the fallback for the moment between logging in and the
 * session being saved, when it's the only thing authenticated.
 */
export async function acquireEchoContext(): Promise<{
  ctx: BrowserContext;
  done: () => Promise<void>;
  live: boolean;
}> {
  if (echoHasSession()) {
    const browser = await chromium.launch({ headless: true, args: HEADLESS_ARGS });
    const ctx = await browser.newContext({ storageState: STATE_FILE() });
    return { ctx, done: async () => void (await browser.close().catch(() => {})), live: false };
  }
  if (loginCtx) return { ctx: loginCtx, done: async () => {}, live: true };
  throw new Error("Not connected to Echo360.");
}

/**
 * Keep the headless browser out of sight and out of the way. Media playback is
 * only ever sniffed for its stream URL, so there's nothing to render and no
 * reason to let it take focus or spin up a GPU.
 */
const HEADLESS_ARGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
];

/**
 * Open a real browser window at Echo360 for login; returns immediately. The user
 * logs in and keeps it open long enough for us to save the session.
 */
export async function loginEcho360(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (loginCtx) {
      await loginCtx.close().catch(() => {});
      loginCtx = null;
    }
    const ctx = await openContext(false, PROFILE);
    loginCtx = ctx;
    ctx.on("close", () => {
      if (loginCtx === ctx) loginCtx = null;
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Confirm login, and if good, persist the session for future launches. */
export async function echoVerify(): Promise<{ connected: boolean; error?: string }> {
  if (!loginCtx) return { connected: false, error: "Click Connect Echo360 first, and keep that window open." };
  try {
    const page = loginCtx.pages()[0] ?? (await loginCtx.newPage());
    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    const ok = !/login\.echo360|\/login/i.test(page.url());
    if (ok) {
      await persistEchoSession(loginCtx);
      // The window has done its one job. Leaving it open is what made every
      // later sync visible, and there's nothing else for the student to do in it.
      const finished = loginCtx;
      loginCtx = null;
      await finished.close().catch(() => {});
    }
    return { connected: ok, error: ok ? undefined : "Not logged in yet — finish logging in, then try again." };
  } catch (e) {
    return { connected: false, error: String(e) };
  }
}

/**
 * List a section's lessons by loading its authenticated home page and capturing
 * whatever JSON the app fetches. Throws a clear error if the session has expired.
 */
export async function listLessons(ctx: BrowserContext, sectionId: string): Promise<EchoLesson[]> {
  const page = await ctx.newPage();
  const captured: { url: string; body: unknown }[] = [];
  page.on("response", async (r) => {
    const u = r.url();
    if (!/echo360\.net/i.test(u)) return;
    if (!/json/i.test(r.headers()["content-type"] ?? "")) return;
    try {
      captured.push({ url: u, body: await r.json() });
    } catch {
      /* ignore */
    }
  });
  try {
    await page
      .goto(`${ORIGIN}/section/${sectionId}/home`, { waitUntil: "networkidle", timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(4000);
    if (LOGIN_URL_RE.test(page.url())) {
      // Give a silent re-auth its chance before declaring the session dead —
      // this verdict is what costs the student a manual login.
      const settled = await ensureEchoLoggedIn(ctx, 1);
      if (!settled.ok) throw new Error(settled.reason ?? "ECHO_SESSION_EXPIRED");
      await page
        .goto(`${ORIGIN}/section/${sectionId}/home`, { waitUntil: "networkidle", timeout: 60000 })
        .catch(() => {});
      await page.waitForTimeout(3000);
      if (LOGIN_URL_RE.test(page.url())) throw new Error("ECHO_SESSION_EXPIRED");
    }
    return pickLessons(captured);
  } finally {
    await page.close().catch(() => {});
  }
}

function pickLessons(captured: { url: string; body: unknown }[]): EchoLesson[] {
  let best: EchoLesson[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) {
      const parsed = node.map(toLesson).filter((l): l is EchoLesson => !!l);
      if (parsed.length > best.length) best = parsed;
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      for (const v of Object.values(node)) visit(v);
    }
  };
  for (const c of captured) visit(c.body);
  return best;
}

function toLesson(item: any): EchoLesson | null {
  if (!item || typeof item !== "object") return null;
  const node = item.lesson?.lesson ?? item.lesson ?? item;
  const id = node?.id ?? item?.id;
  if (!id || typeof id !== "string") return null;
  const medias = item.lesson?.medias ?? item.medias ?? node?.medias ?? node?.video?.medias ?? [];
  const timing = node?.timing ?? item.lesson?.timing ?? {};
  const name = node?.name ?? item?.name ?? node?.title ?? "Lecture";
  if (!timing?.start && !medias?.length && !/lesson/i.test(id)) return null;
  return {
    lessonId: String(id),
    mediaId: medias?.[0]?.id ? String(medias[0].id) : null,
    title: String(name),
    start: timing?.start ?? null,
    end: timing?.end ?? null,
  };
}

export async function fetchTranscript(
  ctx: BrowserContext,
  lessonId: string,
  mediaId: string,
): Promise<string | null> {
  const r = await ctx.request.get(
    `${ORIGIN}/api/ui/echoplayer/lessons/${lessonId}/medias/${mediaId}/transcript`,
    { headers: { accept: "application/json" }, failOnStatusCode: false },
  );
  if (!r.ok()) return null;
  return parseTranscript(await r.text());
}

function parseTranscript(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (typeof j === "string") return j;
    if (typeof j?.transcript === "string") return j.transcript;
    const arr = j?.data ?? j?.cues ?? (Array.isArray(j) ? j : null);
    if (Array.isArray(arr)) {
      const joined = arr.map((c: any) => c?.content ?? c?.text ?? c?.transcript ?? "").join(" ").trim();
      return joined || null;
    }
  } catch {
    /* not JSON */
  }
  if (/-->/.test(text)) {
    return (
      text
        .replace(/^WEBVTT.*$/m, "")
        .split(/\r?\n/)
        .filter((l) => l && !/-->/.test(l) && !/^\d+$/.test(l.trim()))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim() || null
    );
  }
  return text;
}

export interface ClassroomProbe {
  /** Every media id the player referenced — the transcript API is per-media. */
  mediaIds: string[];
  /** Captions the player fetched for itself, if any. */
  transcript: string | null;
  manifest: AudioManifest | null;
}

/**
 * Open a lesson's player once and take everything useful off it: media ids, any
 * caption track the player loads, and the audio manifest.
 *
 * Opening the classroom is the expensive part (a real page load, plus up to 25s
 * waiting for the stream), and the old code paid it purely for the manifest —
 * then transcribed an hour of audio through Whisper for lectures that were
 * already captioned, just because the caption endpoint wanted a media id we
 * hadn't been given. One page load now answers all three questions.
 */
export async function probeClassroom(
  ctx: BrowserContext,
  lessonId: string,
  opts: { needManifest?: boolean } = {},
): Promise<ClassroomProbe> {
  const page: Page = await ctx.newPage();
  const streams: string[] = [];
  const mediaIds = new Set<string>();
  const captions: string[] = [];

  page.on("response", (res) => {
    const url = res.url();
    if (CONTENT_RE.test(url)) streams.push(url);
    // Media ids show up in the player's own request paths.
    for (const m of url.matchAll(/\/medias?\/([0-9a-f-]{36})/gi)) mediaIds.add(m[1]!);
    if (!CAPTION_URL_RE.test(url) || !/echo360\.net/i.test(url)) return;
    void res
      .text()
      .then((body) => {
        const parsed = parseTranscript(body);
        if (parsed && parsed.length > 40) captions.push(parsed);
      })
      .catch(() => {});
  });

  try {
    await page
      .goto(`${ORIGIN}/lesson/${lessonId}/classroom`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await page.evaluate(() => document.querySelector<HTMLMediaElement>("video,audio")?.play?.()).catch(() => {});
    // Captions load early; the stream can take a while to be requested. Stop as
    // soon as we have what this call actually came for.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (opts.needManifest === false && (captions.length > 0 || mediaIds.size > 0)) break;
      if (streams.length > 0) break;
      await page.waitForTimeout(1000);
    }

    let manifest: AudioManifest | null = null;
    if (streams.length > 0) {
      const url = streams.find((u) => /s2_av|s2q0|_av/i.test(u)) ?? streams[0]!;
      const cookies = await ctx.cookies();
      manifest = {
        url,
        headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "), Referer: ORIGIN },
      };
    }
    // Longest wins: a player often loads a short cue window before the full track.
    const transcript = captions.sort((a, b) => b.length - a.length)[0] ?? null;
    return { mediaIds: [...mediaIds], transcript, manifest };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Kept for callers that only want the stream. */
export async function sniffAudioManifest(
  ctx: BrowserContext,
  lessonId: string,
): Promise<AudioManifest | null> {
  return (await probeClassroom(ctx, lessonId)).manifest;
}

/**
 * Try every route to Echo's own captions before falling back to transcribing the
 * audio ourselves. Echo publishes captions per *media*, and a lesson can have
 * several (dual-stream rooms record camera and screen separately) — asking only
 * about the first one silently gave up on the rest.
 */
export async function fetchAnyTranscript(
  ctx: BrowserContext,
  lessonId: string,
  mediaIds: (string | null)[],
): Promise<string | null> {
  for (const mediaId of mediaIds) {
    if (!mediaId) continue;
    const t = await fetchTranscript(ctx, lessonId, mediaId).catch(() => null);
    if (t && t.length > 40) return t;
  }
  return null;
}
