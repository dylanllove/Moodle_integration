import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@uni/db";
import { openContext } from "./session.js";

const PROFILE = ".echo360-profile";
const ORIGIN = "https://echo360.net.au";
const CONTENT_RE = /content\.echo360\.[^/]+\/.+\.m3u8/i;
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

export function clearEchoSession(): void {
  try {
    if (existsSync(STATE_FILE())) rmSync(STATE_FILE());
  } catch {
    /* ignore */
  }
}

/** Save the current session so it survives restarts. */
export async function persistEchoSession(ctx: BrowserContext): Promise<void> {
  await ctx.storageState({ path: STATE_FILE() }).catch(() => {});
}

/**
 * Get a context to run Echo operations. Prefers the live login window; otherwise
 * builds a headless context from the saved session. `done()` cleans up.
 */
export async function acquireEchoContext(): Promise<{
  ctx: BrowserContext;
  done: () => Promise<void>;
  live: boolean;
}> {
  if (loginCtx) return { ctx: loginCtx, done: async () => {}, live: true };
  if (!echoHasSession()) throw new Error("Not connected to Echo360.");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ storageState: STATE_FILE() });
  return { ctx, done: async () => void (await browser.close().catch(() => {})), live: false };
}

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
    if (ok) await persistEchoSession(loginCtx);
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
    if (/login\.echo360|\/login/i.test(page.url())) {
      throw new Error("ECHO_SESSION_EXPIRED");
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
