import type { TranscriptSegment } from "@uni/db";
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

/**
 * Captions with their timing kept. Echo's cues say when each line was spoken;
 * flattening them to one string (as this used to) threw away the only thing that
 * lets a note, a search hit or a flashcard link back to the moment in the video.
 */
export interface Captions {
  text: string;
  segments: TranscriptSegment[] | null;
}

export async function fetchTranscript(
  ctx: BrowserContext,
  lessonId: string,
  mediaId: string,
): Promise<Captions | null> {
  const r = await ctx.request.get(
    `${ORIGIN}/api/ui/echoplayer/lessons/${lessonId}/medias/${mediaId}/transcript`,
    { headers: { accept: "application/json" }, failOnStatusCode: false },
  );
  if (!r.ok()) return null;
  return parseTranscript(await r.text());
}

/** Seconds from a cue field that might be seconds, milliseconds or "hh:mm:ss.mmm". */
function cueTime(v: unknown, ms = false): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return ms ? v / 1000 : v;
  if (typeof v === "string") {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(v.trim());
    if (m) return (+(m[1] ?? 0)) * 3600 + +m[2]! * 60 + +m[3]! + +(m[4] ?? "0").padEnd(3, "0") / 1000;
    const n = Number(v);
    if (Number.isFinite(n)) return ms ? n / 1000 : n;
  }
  return null;
}

function fromCues(cues: TranscriptSegment[]): Captions | null {
  const clean = cues.filter((c) => c.text);
  if (!clean.length) return null;
  const text = clean.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
  const timed = clean.every((c) => Number.isFinite(c.start));
  return text ? { text, segments: timed ? clean : null } : null;
}

export function parseTranscript(body: string): Captions | null {
  const text = body.trim();
  if (!text) return null;
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    j = undefined; // not JSON — VTT/SRT or plain text below
  }
  if (j !== undefined) {
    if (typeof j === "string") return { text: j, segments: null };
    if (typeof j?.transcript === "string") return { text: j.transcript, segments: null };
    // Echo's transcript API: { status, data: { contentJSON: { cues: [...] } } }.
    const arr = [
      j?.data?.contentJSON?.cues,
      j?.contentJSON?.cues,
      j?.data?.cues,
      j?.cues,
      j?.data,
      j,
    ].find(Array.isArray);
    if (arr) {
      return fromCues(
        arr.map((c: any) => {
          const start =
            cueTime(c?.start ?? c?.startTime ?? c?.begin) ?? cueTime(c?.startMs, true) ?? NaN;
          const end = cueTime(c?.end ?? c?.endTime) ?? cueTime(c?.endMs, true) ?? start;
          const t = String(c?.content ?? c?.text ?? c?.transcript ?? "").replace(/\s+/g, " ").trim();
          return { start, end, text: t };
        }),
      );
    }
    // JSON we don't recognise is not a transcript. Storing it as one is how raw
    // API responses ended up as a lecture's "text" and were made into notes.
    return null;
  }
  if (/-->/.test(text)) {
    // WebVTT / SRT: a timing line, then one or more text lines, then a blank.
    const cues: TranscriptSegment[] = [];
    for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) continue;
      const [a, b] = lines[i]!.split("-->").map((x) => x.trim().split(/\s+/)[0]!);
      const start = cueTime(a) ?? NaN;
      const end = cueTime(b) ?? start;
      const t = lines
        .slice(i + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      cues.push({ start, end, text: t });
    }
    return fromCues(cues);
  }
  return { text, segments: null };
}

export interface ClassroomProbe {
  /** Every media id the player referenced — the transcript API is per-media. */
  mediaIds: string[];
  /** Captions the player fetched for itself, if any. */
  transcript: Captions | null;
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
  const captions: Captions[] = [];

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
        if (parsed && parsed.text.length > 40) captions.push(parsed);
      })
      .catch(() => {});
  });

  try {
    await page
      .goto(`${ORIGIN}/lesson/${lessonId}/classroom`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await page.evaluate(() => document.querySelector<HTMLMediaElement>("video,audio")?.play?.()).catch(() => {});
    // Captions load early; the stream can take a while to be requested, and the
    // player asks for several playlists — camera-only, screen+audio, and their
    // quality variants — in no fixed order. Taking the first one that appeared
    // is how a lecture ended up "transcribed" from a silent camera feed, so keep
    // looking until a playlist that actually carries audio turns up.
    const deadline = Date.now() + 25_000;
    let audio: string | null = null;
    const noAudio = new Set<string>();
    while (Date.now() < deadline) {
      if (opts.needManifest === false && (captions.length > 0 || mediaIds.size > 0)) break;
      if (streams.length > 0) {
        audio = await audioPlaylist(ctx, streams, noAudio);
        if (audio) break;
      }
      await page.waitForTimeout(1000);
    }
    // Nothing declared its audio — a single-stream lesson the player only asked
    // for media playlists of. Hand ffmpeg the combined stream, as before; the
    // download-length check catches it if that has no sound either.
    if (!audio && streams.length > 0 && opts.needManifest !== false) {
      audio = streams.find((u) => /_av\./i.test(u)) ?? streams[0]!;
    }

    let manifest: AudioManifest | null = null;
    if (audio) {
      const cookies = await ctx.cookies();
      manifest = {
        url: audio,
        headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "), Referer: ORIGIN },
      };
    }
    // Longest wins: a player often loads a short cue window before the full track.
    const transcript = captions.sort((a, b) => b.text.length - a.text.length)[0] ?? null;
    return { mediaIds: [...mediaIds], transcript, manifest };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * The playlist to read audio from, out of everything the player requested.
 *
 * Echo publishes one master per source: `s1_v` (camera, no sound) and `s2_av`
 * (screen plus the room microphone), and the latter declares its sound as a
 * separate audio-only rendition (`#EXT-X-MEDIA:TYPE=AUDIO,URI="s0q0.m3u8"`).
 * Following that URI downloads just the audio — a few MB for a lecture instead of
 * the whole video — and a master with no audio is never chosen at all.
 */
async function audioPlaylist(
  ctx: BrowserContext,
  urls: string[],
  noAudio: Set<string>,
): Promise<string | null> {
  const masters = [...new Set(urls)]
    .filter((u) => !noAudio.has(u))
    .sort((a, b) => Number(/_av\./i.test(b)) - Number(/_av\./i.test(a)));
  for (const url of masters) {
    const body = await ctx.request
      .get(url, { headers: { Referer: ORIGIN }, failOnStatusCode: false })
      .then((r) => (r.ok() ? r.text() : ""))
      .catch(() => "");
    if (!body.startsWith("#EXTM3U")) continue;
    noAudio.add(url);
    const uri = /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]+)"/.exec(body)?.[1];
    if (uri) return singleFile(ctx, resolvePlaylist(url, uri));
    // A master whose variants carry an audio codec will do, via ffmpeg's own selection.
    if (/#EXT-X-STREAM-INF:[^\n]*mp4a/.test(body)) return url;
    // A media playlist (segments, no variants) can't be told apart here; skip it.
  }
  return null;
}

/**
 * Echo's audio renditions are one fragmented MP4 cut into byte ranges, and
 * ffmpeg's HLS reader stops after the first range of those — a 55-minute lecture
 * came down as its first ten seconds. When every segment is the same file, read
 * that file instead: the whole lecture's audio in one request, in seconds.
 */
async function singleFile(ctx: BrowserContext, playlist: string): Promise<string> {
  const body = await ctx.request
    .get(playlist, { headers: { Referer: ORIGIN }, failOnStatusCode: false })
    .then((r) => (r.ok() ? r.text() : ""))
    .catch(() => "");
  const files = new Set(
    body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(body)?.[1];
  if (files.size === 1 && body.includes("#EXT-X-BYTERANGE")) {
    const [file] = [...files];
    if (!map || map === file) return resolvePlaylist(playlist, file!);
  }
  return playlist;
}

/** A playlist's relative URI, resolved against it, keeping any signed query string. */
function resolvePlaylist(base: string, uri: string): string {
  const resolved = new URL(uri, base);
  if (!resolved.search) resolved.search = new URL(base).search;
  return resolved.toString();
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
): Promise<Captions | null> {
  let best: Captions | null = null;
  for (const mediaId of mediaIds) {
    if (!mediaId) continue;
    const t = await fetchTranscript(ctx, lessonId, mediaId).catch(() => null);
    if (t && t.text.length > (best?.text.length ?? 40)) best = t;
  }
  return best;
}
