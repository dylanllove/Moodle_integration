import type { BrowserContext, Page } from "playwright";
import { createHash } from "node:crypto";
import { upsert } from "@uni/db";
import { detectRecordingLinks } from "./recordings.js";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const abs = (base: string, href: string) => new URL(href, base).toString();

export interface ScrapeCounts {
  courses: number;
  assignments: number;
  lectures: number;
}

/**
 * Scrape enrolled courses, their assignments, and lecture-recording links from
 * a Moodle instance using the user's logged-in session. Selectors target
 * standard Moodle 4.x markup; they're kept in one place so they're easy to
 * adjust for a specific instance's theme.
 */
export async function scrapeMoodle(
  ctx: BrowserContext,
  base: string,
): Promise<ScrapeCounts> {
  const counts: ScrapeCounts = { courses: 0, assignments: 0, lectures: 0 };
  const page = await ctx.newPage();

  // 1. Enrolled courses (Moodle 4.x "My courses" page).
  const courses = await listCourses(page, base);
  for (const c of courses) {
    upsert(
      "courses",
      { id: c.id, lms: "moodle", name: c.name, code: c.code, url: c.url, color: null },
      ["lms", "name", "code", "url", "color"],
    );
    counts.courses++;
  }

  // 2. Walk each course page for assignments, resources and recordings.
  for (const c of courses) {
    try {
      await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 30000 });

      const assignLinks = await page.$$eval('a[href*="/mod/assign/view.php"]', (as) =>
        as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: a.textContent?.trim() ?? "" })),
      );
      for (const a of dedupeByHref(assignLinks)) {
        const detail = await scrapeAssignment(page, a.href).catch(() => null);
        const id = "moodle:assign:" + sha(a.href);
        upsert(
          "assignments",
          {
            id,
            course_id: c.id,
            title: detail?.title || a.text || "Assignment",
            brief: detail?.brief ?? null,
            url: a.href,
            due_at: detail?.dueAt ?? null,
            status: "open",
            attachments: detail?.attachments ?? [],
          },
          ["course_id", "title", "brief", "url", "due_at", "status", "attachments"],
        );
        counts.assignments++;
      }

      // Recording links (Panopto/Echo360/Kaltura embeds, LTI, direct media).
      const recs = await detectRecordingLinks(page, base);
      for (const r of recs) {
        const id = "moodle:lec:" + sha(r.url);
        upsert(
          "lectures",
          {
            id,
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
      // Skip a course that fails rather than aborting the whole sync.
    }
  }

  await page.close();
  return counts;
}

interface CourseRow {
  id: string;
  name: string;
  code: string | null;
  url: string;
}

async function listCourses(page: Page, base: string): Promise<CourseRow[]> {
  // Try the "My courses" page, falling back to the dashboard.
  for (const path of ["/my/courses.php", "/my/", "/"]) {
    try {
      await page.goto(abs(base, path), { waitUntil: "domcontentloaded", timeout: 30000 });
      const links = await page.$$eval('a[href*="/course/view.php?id="]', (as) =>
        as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: a.textContent?.trim() ?? "" })),
      );
      const rows = dedupeByHref(links)
        .filter((l) => l.text && l.text.length > 1)
        .map((l) => {
          const url = l.href;
          const idMatch = url.match(/id=(\d+)/);
          const cid = "moodle:course:" + (idMatch?.[1] ?? sha(url));
          return { id: cid, name: l.text, code: extractCode(l.text), url };
        });
      if (rows.length) return rows;
    } catch {
      // try next path
    }
  }
  return [];
}

interface AssignmentDetail {
  title: string;
  brief: string | null;
  dueAt: string | null;
  attachments: { name: string; url: string }[];
}

async function scrapeAssignment(page: Page, url: string): Promise<AssignmentDetail> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return page.evaluate(() => {
    const title =
      document.querySelector(".page-header-headings h1, h1")?.textContent?.trim() ?? "Assignment";
    const brief =
      document
        .querySelector("#intro, .activity-description, [data-region='activity-information']")
        ?.textContent?.trim() ?? null;

    // Due date: Moodle renders a dates table; find a cell labelled "Due".
    let dueAt: string | null = null;
    const cells = Array.from(document.querySelectorAll("td, th, .fitem, dt, dd"));
    for (let i = 0; i < cells.length; i++) {
      if (/due date/i.test(cells[i]?.textContent ?? "")) {
        const val = cells[i + 1]?.textContent?.trim();
        if (val) {
          const d = new Date(val);
          if (!isNaN(d.getTime())) dueAt = d.toISOString();
        }
      }
    }

    const attachments = Array.from(
      document.querySelectorAll("#intro a[href], .fileuploadsubmission a[href]"),
    )
      .map((a) => ({ name: a.textContent?.trim() ?? "file", url: (a as HTMLAnchorElement).href }))
      .filter((a) => a.url);

    return { title, brief, dueAt, attachments };
  });
}

function extractCode(name: string): string | null {
  const m = name.match(/\b[A-Z]{2,4}\s?\d{3,4}\b/);
  return m ? m[0].replace(/\s+/g, "") : null;
}

function dedupeByHref<T extends { href: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.href) ? false : (seen.add(i.href), true)));
}
