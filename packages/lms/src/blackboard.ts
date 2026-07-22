import type { BrowserContext, Page } from "playwright";
import { createHash } from "node:crypto";
import { upsert } from "@uni/db";
import { detectRecordingLinks } from "./recordings.js";
import type { ScrapeCounts } from "./moodle.js";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/**
 * Best-effort Blackboard (Learn) scraper. Blackboard markup varies a lot
 * between Original and Ultra and is heavily JS-rendered, so this reliably
 * collects the course list and any recording links; assignment *deadlines*
 * come from the iCal feed (see ical.ts), which is the dependable path here.
 */
export async function scrapeBlackboard(
  ctx: BrowserContext,
  base: string,
): Promise<ScrapeCounts> {
  const counts: ScrapeCounts = { courses: 0, assignments: 0, lectures: 0 };
  const page = await ctx.newPage();

  const courses = await listCourses(page, base);
  for (const c of courses) {
    upsert(
      "courses",
      { id: c.id, lms: "blackboard", name: c.name, code: null, url: c.url, color: null },
      ["lms", "name", "code", "url", "color"],
    );
    counts.courses++;
  }

  for (const c of courses) {
    try {
      await page.goto(c.url, { waitUntil: "networkidle", timeout: 40000 });
      const recs = await detectRecordingLinks(page, base);
      for (const r of recs) {
        upsert(
          "lectures",
          {
            id: "bb:lec:" + sha(r.url),
            course_id: c.id,
            title: r.title || "Lecture recording",
            url: r.url,
            media_url: r.mediaUrl ?? null,
            provider: r.provider,
            recorded_at: null,
            media_path: null,
            duration_sec: null,
          },
          ["course_id", "title", "url", "media_url", "provider", "recorded_at", "media_path", "duration_sec"],
        );
        counts.lectures++;
      }
    } catch {
      // skip failing course
    }
  }

  await page.close();
  return counts;
}

interface CourseRow {
  id: string;
  name: string;
  url: string;
}

async function listCourses(page: Page, base: string): Promise<CourseRow[]> {
  // Ultra course list, then Original fallbacks.
  for (const path of ["/ultra/course", "/ultra/courses", "/webapps/portal/execute/tabs/tabAction"]) {
    try {
      await page.goto(new URL(path, base).toString(), {
        waitUntil: "networkidle",
        timeout: 40000,
      });
      const links = await page.$$eval(
        'a[href*="/ultra/courses/"], a[href*="/webapps/blackboard/execute/courseMain"], a[href*="course_id="]',
        (as) =>
          as.map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: a.textContent?.trim() ?? "",
          })),
      );
      const seen = new Set<string>();
      const rows = links
        .filter((l) => l.text && l.text.length > 1 && !seen.has(l.href) && seen.add(l.href))
        .map((l) => ({ id: "bb:course:" + sha(l.href), name: l.text, url: l.href }));
      if (rows.length) return rows;
    } catch {
      // try next
    }
  }
  return [];
}
