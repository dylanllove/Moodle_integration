import type { BrowserContext, Page } from "playwright";
import { getSetting, setSetting } from "@uni/db";
import { openContext } from "./session.js";

const PROFILE = ".echo360-profile";
const ORIGIN = "https://echo360.net.au";
const CONTENT_RE = /content\.echo360\.[^/]+\/.+\.m3u8/i;

// Echo360 is a token-based SPA whose session does NOT survive a fresh headless
// browser launch (nothing useful persists to the profile on disk). So we keep
// the logged-in browser alive in `loginCtx` and run every operation through it.
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

export function openEchoContext(headless: boolean): Promise<BrowserContext> {
  return openContext(headless, PROFILE);
}

/** The live authenticated context, or null if the login window isn't open. */
export function activeEchoContext(): BrowserContext | null {
  return loginCtx;
}

/** Fast, no-launch status flag (set by verify/sync). */
export function echoConnected(): boolean {
  return getSetting("echo360_connected") === "true" && loginCtx != null;
}

/**
 * Open a real browser window at Echo360 for login and return immediately. The
 * user logs in and LEAVES THE WINDOW OPEN — the live context is what we use.
 */
export async function loginEcho360(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (loginCtx) {
      await loginCtx.close().catch(() => {});
      loginCtx = null;
    }
    const ctx = await openEchoContext(false);
    loginCtx = ctx;
    ctx.on("close", () => {
      if (loginCtx === ctx) loginCtx = null;
      setSetting("echo360_connected", "false");
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Confirm the live window is actually logged in (not on the SSO login page). */
export async function echoVerify(): Promise<{ connected: boolean; error?: string }> {
  if (!loginCtx) return { connected: false, error: "Click Connect Echo360 first, and keep that window open." };
  try {
    const page = loginCtx.pages()[0] ?? (await loginCtx.newPage());
    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    const ok = !/login\.echo360|\/login/i.test(page.url());
    setSetting("echo360_connected", ok ? "true" : "false");
    return { connected: ok, error: ok ? undefined : "Not logged in yet — finish logging in, then try again." };
  } catch (e) {
    return { connected: false, error: String(e) };
  }
}

/**
 * List a section's lessons by loading its (authenticated) home page and
 * capturing whatever JSON the app fetches — no guessing the endpoint. Logs the
 * endpoints it saw for diagnostics.
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
      /* ignore non-json */
    }
  });

  try {
    await page
      .goto(`${ORIGIN}/section/${sectionId}/home`, { waitUntil: "networkidle", timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(4000);
    if (/login\.echo360|\/login/i.test(page.url())) {
      throw new Error("Not authenticated — reconnect and keep the Echo360 window open.");
    }
    // eslint-disable-next-line no-console
    console.log(
      `[echo360] section ${sectionId}: captured JSON from ${captured.length} calls: ` +
        captured.map((c) => c.url.replace(ORIGIN, "")).slice(0, 20).join(" | "),
    );
    return pickLessons(captured);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Search captured JSON payloads for the array that looks like a lesson list. */
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

/** Try to interpret an arbitrary object as a lesson (defensive across shapes). */
function toLesson(item: any): EchoLesson | null {
  if (!item || typeof item !== "object") return null;
  const node = item.lesson?.lesson ?? item.lesson ?? item;
  const id = node?.id ?? item?.id;
  if (!id || typeof id !== "string") return null;
  const medias = item.lesson?.medias ?? item.medias ?? node?.medias ?? node?.video?.medias ?? [];
  const timing = node?.timing ?? item.lesson?.timing ?? {};
  const name = node?.name ?? item?.name ?? node?.title ?? "Lecture";
  // Only accept nodes that look lesson-ish (have timing or media), to avoid junk.
  if (!timing?.start && !medias?.length && !/lesson/i.test(id)) return null;
  return {
    lessonId: String(id),
    mediaId: medias?.[0]?.id ? String(medias[0].id) : null,
    title: String(name),
    start: timing?.start ?? null,
    end: timing?.end ?? null,
  };
}

/** Fetch an existing Echo360 transcript, or null if none exist. */
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

/** Load a lesson's classroom page (authenticated) and sniff its signed HLS manifest. */
export async function sniffAudioManifest(
  ctx: BrowserContext,
  lessonId: string,
): Promise<AudioManifest | null> {
  const page: Page = await ctx.newPage();
  const found: string[] = [];
  page.on("response", (res) => {
    if (CONTENT_RE.test(res.url())) found.push(res.url());
  });
  try {
    await page
      .goto(`${ORIGIN}/lesson/${lessonId}/classroom`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await page.evaluate(() => document.querySelector<HTMLMediaElement>("video,audio")?.play?.()).catch(() => {});
    const deadline = Date.now() + 25_000;
    while (found.length === 0 && Date.now() < deadline) await page.waitForTimeout(1000);
    if (found.length === 0) return null;
    const url = found.find((u) => /s2_av|s2q0|_av/i.test(u)) ?? found[0]!;
    const cookies = await ctx.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return { url, headers: { Cookie: cookieHeader, Referer: ORIGIN } };
  } finally {
    await page.close().catch(() => {});
  }
}
