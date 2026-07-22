import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { dataDir } from "@uni/db";

/** Directory where a logged-in browser profile (cookies etc.) persists. */
export function profileDir(name = ".lms-profile"): string {
  return join(dataDir(), name);
}

/**
 * Open a persistent browser context. Because it's persistent, cookies from a
 * previous login are reused automatically — so sync runs headless without a
 * fresh login, and login() just needs to happen once. `profile` lets callers
 * keep separate sessions (e.g. a dedicated Echo360 profile).
 */
export async function openContext(headless: boolean, profile = ".lms-profile"): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir(profile), {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/** True if the context appears to hold a live LMS session (heuristic on cookies). */
export async function looksLoggedIn(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies();
  return cookies.some((c) =>
    /moodlesession|bb_|blackboard|s_session_id|_shibsession|jsessionid/i.test(c.name),
  );
}

/** Detect which LMS we're on, from the page DOM/URL. */
export async function detectLms(page: Page): Promise<"moodle" | "blackboard" | "unknown"> {
  const url = page.url().toLowerCase();
  if (url.includes("blackboard") || url.includes("/ultra/") || url.includes("/webapps/"))
    return "blackboard";
  if (url.includes("moodle") || url.includes("/my/") || url.includes("/course/view.php"))
    return "moodle";

  const hint = await page
    .evaluate(() => {
      const gen = document
        .querySelector('meta[name="generator"]')
        ?.getAttribute("content")
        ?.toLowerCase();
      const html = document.documentElement.className.toLowerCase();
      const body = document.body?.className.toLowerCase() ?? "";
      return { gen: gen ?? "", cls: html + " " + body };
    })
    .catch(() => ({ gen: "", cls: "" }));

  if (hint.gen.includes("moodle") || /\bmoodle\b|path-my|dir-ltr/.test(hint.cls)) return "moodle";
  if (/blackboard|bb-|ultra/.test(hint.cls)) return "blackboard";
  return "unknown";
}
