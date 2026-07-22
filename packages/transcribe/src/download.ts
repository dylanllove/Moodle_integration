import { openContext, profileDir } from "@uni/lms";
import { dataDir, type Lecture } from "@uni/db";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { extractAudioMp3 } from "./ffmpeg.js";

export interface AudioSource {
  /** Path to a local mono 16kHz MP3 ready for transcription. */
  audioPath: string;
}

const MEDIA_RE = /\.(m3u8|mp4|m4v|webm|mov|m4a|mp3)(\?|$)/i;

/**
 * Resolve a lecture's recording to a local WAV, reusing the logged-in browser
 * session. Handles direct media URLs and best-effort sniffing of embedded
 * players (Panopto/Echo360/Kaltura) by watching network traffic for a media
 * URL, then letting ffmpeg pull audio (including HLS streams).
 *
 * DRM-protected streams can't be captured; those raise a clear error.
 */
export async function resolveAudio(lecture: Lecture): Promise<AudioSource> {
  const outDir = join(dataDir(), "media");
  mkdirSync(outDir, { recursive: true });
  const audioPath = join(outDir, `${lecture.id.replace(/[^\w.-]/g, "_")}.mp3`);

  // Fast path: a known direct media URL (incl. Moodle pluginfile with ?token=).
  if (lecture.media_url && MEDIA_RE.test(lecture.media_url)) {
    await extractAudioMp3(lecture.media_url, audioPath);
    return { audioPath };
  }

  const target = lecture.media_url || lecture.url;
  if (!target) throw new Error("Lecture has no URL to fetch.");

  const ctx = await openContext(true);
  try {
    const page = await ctx.newPage();
    const found: string[] = [];
    page.on("response", (res) => {
      const u = res.url();
      if (MEDIA_RE.test(u)) found.push(u);
    });

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    // Nudge players that only load media on play.
    await page
      .evaluate(() => document.querySelector<HTMLMediaElement>("video,audio")?.play?.())
      .catch(() => {});

    // Also read any <video>/<source> src directly.
    const domSrc = await page
      .evaluate(() => {
        const v = document.querySelector<HTMLMediaElement>("video[src], audio[src]");
        const s = document.querySelector<HTMLSourceElement>("video source[src], audio source[src]");
        return v?.src || s?.src || null;
      })
      .catch(() => null);
    if (domSrc && MEDIA_RE.test(domSrc)) found.unshift(domSrc);

    // Wait briefly for a media request to appear.
    const deadline = Date.now() + 20_000;
    while (found.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(1000);
    }

    if (found.length === 0) {
      throw new Error(
        "Couldn't find a downloadable media stream on this page (it may be DRM-protected or need manual navigation).",
      );
    }

    // Prefer a progressive file; else use the HLS manifest.
    const progressive = found.find((u) => /\.(mp4|m4v|webm|mov|m4a|mp3)(\?|$)/i.test(u));
    const cookieHeader = await cookieHeaderFor(ctx, target);

    if (progressive) {
      const resp = await ctx.request.get(progressive);
      if (!resp.ok()) throw new Error(`Media download failed: ${resp.status()}`);
      const tmp = join(outDir, `${lecture.id.replace(/[^\w.-]/g, "_")}.src`);
      writeFileSync(tmp, Buffer.from(await resp.body()));
      await extractAudioMp3(tmp, audioPath);
    } else {
      // HLS: hand the manifest URL to ffmpeg with the session cookie.
      const m3u8 = found.find((u) => /\.m3u8(\?|$)/i.test(u))!;
      await extractAudioMp3(m3u8, audioPath, cookieHeader ? { Cookie: cookieHeader } : undefined);
    }

    await page.close();
    return { audioPath };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function cookieHeaderFor(
  ctx: Awaited<ReturnType<typeof openContext>>,
  url: string,
): Promise<string | null> {
  try {
    const host = new URL(url).hostname;
    const cookies = await ctx.cookies();
    const rel = cookies.filter((c) => host.endsWith(c.domain.replace(/^\./, "")));
    return rel.length ? rel.map((c) => `${c.name}=${c.value}`).join("; ") : null;
  } catch {
    return null;
  }
}

// Referenced so the profile dir helper stays in the module graph for clarity.
export { profileDir };
