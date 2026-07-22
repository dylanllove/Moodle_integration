import type { Page } from "playwright";

export interface RecordingLink {
  url: string;
  title: string;
  provider: "panopto" | "echo360" | "kaltura" | "direct" | "lti";
  mediaUrl?: string;
}

const PROVIDER_PATTERNS: [RegExp, RecordingLink["provider"]][] = [
  [/panopto\.com|\/Panopto\//i, "panopto"],
  [/echo360\.|\/echo360/i, "echo360"],
  [/kaltura\.|mediaspace|\/browseandembed\//i, "kaltura"],
  [/\.(mp4|m4v|webm|mov|mp3|m4a)(\?|$)/i, "direct"],
];

function providerFor(url: string): RecordingLink["provider"] | null {
  for (const [re, p] of PROVIDER_PATTERNS) if (re.test(url)) return p;
  return null;
}

/**
 * Find lecture-recording links on the current page: anchors, iframes, and
 * <video>/<source> elements pointing at known lecture-capture providers or
 * direct media files.
 */
export async function detectRecordingLinks(page: Page, _base: string): Promise<RecordingLink[]> {
  const raw = await page.evaluate(() => {
    const out: { url: string; title: string }[] = [];
    const push = (url: string | null | undefined, title: string) => {
      if (url) out.push({ url, title: title.trim() });
    };
    document.querySelectorAll("a[href]").forEach((a) => {
      const el = a as HTMLAnchorElement;
      push(el.href, el.textContent ?? "");
    });
    document.querySelectorAll("iframe[src]").forEach((f) => {
      const el = f as HTMLIFrameElement;
      push(el.src, el.title || "Embedded recording");
    });
    document.querySelectorAll("video[src], video source[src]").forEach((v) => {
      push((v as HTMLMediaElement).src || (v as HTMLSourceElement).src, "Video");
    });
    return out;
  });

  const results: RecordingLink[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    // Moodle LTI activities often front a Panopto/Echo player.
    const isLti = /\/mod\/lti\/view\.php|\/mod\/bigbluebuttonbn\//i.test(r.url);
    const provider = providerFor(r.url) ?? (isLti ? "lti" : null);
    if (!provider) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    results.push({
      url: r.url,
      title: r.title || "Lecture recording",
      provider,
      mediaUrl: provider === "direct" ? r.url : undefined,
    });
  }
  return results;
}
