import { openContext } from "@uni/lms";
import type { Lecture } from "@uni/db";

/** Something ffmpeg can read audio from: a URL (with auth headers) or a local file. */
export interface MediaSource {
  input: string;
  headers?: Record<string, string>;
}

const MEDIA_RE = /\.(m3u8|mp4|m4v|webm|mov|m4a|mp3)(\?|$)/i;

/**
 * Find where a lecture's recording actually streams from, reusing the logged-in
 * browser session. Handles direct media URLs and best-effort sniffing of embedded
 * players (Panopto/Kaltura/…) by watching network traffic for a media URL.
 *
 * It returns the source rather than downloading it: ffmpeg reads the stream
 * itself with the session cookie and keeps only the audio, instead of the whole
 * video file being buffered in memory and written to disk first.
 *
 * DRM-protected streams can't be captured; those raise a clear error.
 */
export async function resolveMediaSource(lecture: Lecture): Promise<MediaSource> {
  // Fast path: a known direct media URL (incl. Moodle pluginfile with ?token=).
  if (lecture.media_url && MEDIA_RE.test(lecture.media_url)) return { input: lecture.media_url };

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
    const url =
      found.find((u) => /\.(mp4|m4v|webm|mov|m4a|mp3)(\?|$)/i.test(u)) ??
      found.find((u) => /\.m3u8(\?|$)/i.test(u))!;
    const cookie = await cookieHeaderFor(ctx, url);
    await page.close();
    return { input: url, headers: cookie ? { Cookie: cookie, Referer: target } : undefined };
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
