import { createHash } from "node:crypto";
import { getDb, upsert } from "@uni/db";

const BASE = () => (process.env.MOODLE_URL ?? "").replace(/\/$/, "");
const TOKEN = () => process.env.MOODLE_TOKEN ?? "";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** True when a Moodle token + URL are configured (the reliable API path). */
export function moodleApiConfigured(): boolean {
  return Boolean(BASE() && TOKEN());
}

/**
 * Call a Moodle Web Services function (POST, form-encoded, array-aware).
 * Exported so sibling modules (materials, grades) share one transport, token
 * handling and error shape rather than each rolling their own fetch.
 */
export async function moodleWs<T = any>(
  fn: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const body = new URLSearchParams({
    wstoken: TOKEN(),
    wsfunction: fn,
    moodlewsrestformat: "json",
  });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const res = await fetch(`${BASE()}/webservice/rest/server.php`, { method: "POST", body });
  const json = (await res.json()) as any;
  if (json && json.exception) {
    throw new Error(`Moodle ${fn}: ${json.errorcode} — ${json.message}`);
  }
  return json as T;
}

/** Local shorthand — this file calls Web Services on nearly every line. */
const ws = moodleWs;

export interface MoodleSyncCounts {
  courses: number;
  assignments: number;
  lectures: number;
  events: number;
}

/** Full sync from the Moodle API into the local DB. */
export async function syncMoodleApi(): Promise<MoodleSyncCounts> {
  const counts: MoodleSyncCounts = { courses: 0, assignments: 0, lectures: 0, events: 0 };
  const info = await ws<{ userid: number }>("core_webservice_get_site_info");

  // --- Courses ---
  const db = getDb();
  const courses = await ws<MoodleCourse[]>("core_enrol_get_users_courses", {
    userid: info.userid,
  });
  const allCourses = courses.filter((c) => c.id && c.fullname);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const c of allCourses) {
    const id = `moodle:course:${c.id}`;
    // Auto-active heuristic: a real, currently-running class is bounded by a
    // start AND end date that spans today (community/notice groups have no end).
    const autoActive =
      c.visible !== 0 && c.enddate > 0 && c.startdate <= nowSec && c.enddate >= nowSec ? 1 : 0;
    const override = (
      db.prepare("SELECT active_override FROM courses WHERE id = ?").get(id) as
        | { active_override: number | null }
        | undefined
    )?.active_override;
    const active = override == null ? autoActive : override;
    upsert(
      "courses",
      {
        id,
        lms: "moodle",
        name: c.fullname,
        code: c.shortname || null,
        url: `${BASE()}/course/view.php?id=${c.id}`,
        color: null,
        start_date: c.startdate ? new Date(c.startdate * 1000).toISOString() : null,
        end_date: c.enddate ? new Date(c.enddate * 1000).toISOString() : null,
        active,
      },
      ["lms", "name", "code", "url", "color", "start_date", "end_date", "active"],
    );
    counts.courses++;
  }

  // Only sync detail (assignments/lectures) for ACTIVE courses — keeps things
  // focused on what the student is currently taking.
  const activeIds = new Set(
    (
      db
        .prepare("SELECT id FROM courses WHERE active = 1 AND excluded = 0")
        .all() as { id: string }[]
    ).map((r) => r.id),
  );
  const teachingCourses = allCourses.filter((c) => activeIds.has(`moodle:course:${c.id}`));

  // --- Assignments (batched) ---
  const courseIdParams: Record<string, number> = {};
  teachingCourses.forEach((c, i) => (courseIdParams[`courseids[${i}]`] = c.id));
  try {
    const assignData = await ws<{ courses: MoodleAssignCourse[] }>(
      "mod_assign_get_assignments",
      courseIdParams,
    );
    for (const c of assignData.courses ?? []) {
      for (const a of c.assignments ?? []) {
        const id = `moodle:assign:${a.id}`;
        upsert(
          "assignments",
          {
            id,
            course_id: `moodle:course:${c.id}`,
            title: a.name,
            brief: stripHtml(a.intro ?? ""),
            url: `${BASE()}/mod/assign/view.php?id=${a.cmid}`,
            due_at: a.duedate ? new Date(a.duedate * 1000).toISOString() : null,
            open_at: a.allowsubmissionsfromdate
              ? new Date(a.allowsubmissionsfromdate * 1000).toISOString()
              : null,
            status: "open",
            attachments: (a.introattachments ?? []).map((f) => ({
              name: f.filename,
              url: withToken(f.fileurl),
            })),
          },
          ["course_id", "title", "brief", "url", "due_at", "open_at", "status", "attachments"],
        );
        counts.assignments++;
      }
    }
  } catch (e) {
    // Some sites restrict this function; deadlines still come from the calendar below.
    console.warn("assignment sync skipped:", String(e));
  }

  // --- Calendar deadlines/events ---
  try {
    const from = Math.floor(Date.now() / 1000) - 7 * 86400;
    const cal = await ws<{ events: MoodleCalEvent[] }>(
      "core_calendar_get_action_events_by_timesort",
      { timesortfrom: from, limitnum: 50 },
    );
    for (const e of cal.events ?? []) {
      const id = `moodle:cal:${e.id}`;
      upsert(
        "events",
        {
          id,
          course_id: e.course?.id ? `moodle:course:${e.course.id}` : null,
          title: e.name,
          kind: classify(e.name, e.modulename),
          source: "ical",
          start_at: new Date(e.timesort * 1000).toISOString(),
          end_at: null,
          url: e.url ?? null,
        },
        ["course_id", "title", "kind", "source", "start_at", "end_at", "url"],
      );
      counts.events++;
    }
  } catch (e) {
    console.warn("calendar sync skipped:", String(e));
  }

  // --- Lecture recordings + course prose from course contents ---
  for (const c of teachingCourses) {
    try {
      counts.lectures += await syncCourseLectures(c.id);
    } catch {
      // skip a course that fails
    }
    // Forum posts/announcements (often state attendance & logistics).
    try {
      const cId = `moodle:course:${c.id}`;
      db.prepare("DELETE FROM course_text WHERE course_id = ? AND source = 'forum'").run(cId);
      const posts = await getCourseForumPosts(c.id);
      for (const p of posts) {
        if (p.text.length > 20) storeText(cId, "forum", p.subject, p.text);
      }
    } catch {
      // forum not accessible; not fatal
    }
  }

  materialiseAssignmentEvents();
  return counts;
}

/** Detect lecture-recording modules in a course and upsert them as lectures. */
async function syncCourseLectures(courseId: number): Promise<number> {
  const sections = await ws<MoodleSection[]>("core_course_get_contents", { courseid: courseId });
  if (!Array.isArray(sections)) return 0;

  // Capture course prose (section summaries + labels) for grounded Q&A about
  // logistics like attendance requirements.
  const db = getDb();
  const cId = `moodle:course:${courseId}`;
  db.prepare("DELETE FROM course_text WHERE course_id = ? AND source IN ('section','label')").run(cId);
  for (const s of sections) {
    const summary = stripHtml((s as { summary?: string }).summary ?? "");
    if (summary.length > 20) storeText(cId, "section", (s as { name?: string }).name ?? null, summary);
    for (const m of s.modules ?? []) {
      if (m.modname === "label") {
        const text = stripHtml((m as { description?: string }).description ?? m.name ?? "");
        if (text.length > 20) storeText(cId, "label", null, text);
      }
    }
  }

  // Resolve external URLs for `url` modules in one call.
  const urlMap = new Map<number, string>();
  try {
    const urls = await ws<{ urls: { coursemodule: number; externalurl: string; name: string }[] }>(
      "mod_url_get_urls_by_courses",
      { "courseids[0]": courseId },
    );
    for (const u of urls.urls ?? []) urlMap.set(u.coursemodule, u.externalurl);
  } catch {
    // not fatal
  }

  let n = 0;
  for (const s of sections) {
    for (const m of s.modules ?? []) {
      const rec = classifyLecture(m, urlMap.get(m.id));
      if (!rec) continue;
      const id = `moodle:lec:${m.id}`;
      upsert(
        "lectures",
        {
          id,
          course_id: `moodle:course:${courseId}`,
          title: m.name,
          url: rec.pageUrl,
          media_url: rec.mediaUrl,
          provider: rec.provider,
          recorded_at: null,
          media_path: null,
          duration_sec: null,
        },
        ["course_id", "title", "url", "media_url", "provider", "recorded_at", "media_path", "duration_sec"],
      );
      n++;
    }
  }
  return n;
}

interface LectureRec {
  provider: string;
  pageUrl: string | null;
  mediaUrl: string | null;
}

const VIDEO_MIME = /^video\//;
// Strong recording signals only — avoids matching "Lecture slides" or stray "video" links.
const NAME_HINT = /(recording|lecture video|lecture capture|panopto|echo\s?360|zoom (meeting|recording)|playback|re-?watch)/i;
const PROVIDER_HINT: [RegExp, string][] = [
  [/panopto/i, "panopto"],
  [/echo360|echo/i, "echo360"],
  [/kaltura|mediaspace/i, "kaltura"],
  [/zoom/i, "zoom"],
];

const SLIDE_MIME = /pdf|presentation|powerpoint/i;

function classifyLecture(m: MoodleModule, externalUrl?: string): LectureRec | null {
  // A file resource that is a video → directly downloadable with the token.
  const videoFile = (m.contents ?? []).find(
    (f) => f.type === "file" && VIDEO_MIME.test(f.mimetype ?? ""),
  );
  if (videoFile) {
    return { provider: "direct", pageUrl: m.url ?? null, mediaUrl: withToken(videoFile.fileurl) };
  }

  // A slide deck (PPTX/PDF) named like a lecture → treat the slides AS the
  // lecture content (text extracted later). This is the reliably-pullable form.
  const slideFile = (m.contents ?? []).find(
    (f) => f.type === "file" && SLIDE_MIME.test(f.mimetype ?? ""),
  );
  if (slideFile && /lecture|lec\b|week\s*\d|session\s*\d|topic\s*\d/i.test(m.name)) {
    return { provider: "slides", pageUrl: m.url ?? null, mediaUrl: withToken(slideFile.fileurl) };
  }

  // A `url`/lti module that points at (or is named like) a lecture recording.
  const target = externalUrl || "";
  const named = NAME_HINT.test(m.name);
  const providerMatch = PROVIDER_HINT.find(([re]) => re.test(target) || re.test(m.name));
  if (m.modname === "lti" && (named || providerMatch)) {
    return { provider: providerMatch?.[1] ?? "lti", pageUrl: m.url ?? null, mediaUrl: null };
  }
  if (m.modname === "url" && (providerMatch || (named && target))) {
    const isMedia = /\.(mp4|m4v|webm|mov|m4a|mp3)(\?|$)/i.test(target);
    return {
      provider: providerMatch?.[1] ?? (isMedia ? "direct" : "url"),
      pageUrl: target || m.url || null,
      mediaUrl: isMedia ? target : null,
    };
  }
  return null;
}

/** Append the WS token so Moodle pluginfile URLs are downloadable. */
export function withToken(fileurl: string | null | undefined): string | null {
  if (!fileurl) return null;
  const sep = fileurl.includes("?") ? "&" : "?";
  return `${fileurl}${sep}token=${TOKEN()}`;
}

export interface ForumPost {
  forum: string;
  subject: string;
  author: string;
  date: string | null;
  text: string;
}

/** Fetch forum discussions (first posts — typically staff announcements). */
export async function getCourseForumPosts(courseNumId: number): Promise<ForumPost[]> {
  const out: ForumPost[] = [];
  let forums: { id: number; name: string }[] = [];
  try {
    forums = await ws("mod_forum_get_forums_by_courses", { "courseids[0]": courseNumId });
  } catch {
    return out;
  }
  for (const f of forums ?? []) {
    try {
      const d = await ws<{ discussions: any[] }>("mod_forum_get_forum_discussions", {
        forumid: f.id,
      });
      for (const disc of d.discussions ?? []) {
        out.push({
          forum: f.name,
          subject: disc.name ?? disc.subject ?? "(untitled)",
          author: disc.userfullname ?? "",
          date: disc.timemodified ? new Date(disc.timemodified * 1000).toISOString() : null,
          text: stripHtml(disc.message ?? ""),
        });
      }
    } catch {
      // skip forum that can't be read
    }
  }
  return out;
}

export interface SlideFile {
  name: string;
  url: string;
  mimetype: string;
}

/** Collect lecture-slide files (PDF/PowerPoint) from a course's resources. */
export async function getCourseSlideFiles(courseNumId: number): Promise<SlideFile[]> {
  const sections = await ws<MoodleSection[]>("core_course_get_contents", { courseid: courseNumId });
  if (!Array.isArray(sections)) return [];
  const slides: SlideFile[] = [];
  const isSlide = (mt: string) =>
    /pdf|presentation|powerpoint|officedocument\.presentation|vnd\.ms-powerpoint/i.test(mt);
  for (const s of sections) {
    for (const m of s.modules ?? []) {
      for (const f of m.contents ?? []) {
        if (f.type === "file" && isSlide(f.mimetype ?? "")) {
          slides.push({
            name: f.filename,
            url: withToken(f.fileurl)!,
            mimetype: f.mimetype ?? "",
          });
        }
      }
    }
  }
  return slides;
}

/** Numeric Moodle course id from our stable id (moodle:course:NNN). */
export function courseNumericId(courseId: string): number | null {
  const m = courseId.match(/moodle:course:(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Persist a chunk of course prose for the chatbot to reason over. */
function storeText(courseId: string, source: string, title: string | null, body: string): void {
  getDb()
    .prepare(
      "INSERT INTO course_text (id, course_id, source, title, body) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(`${source}:${sha(courseId + (title ?? "") + body)}`, courseId, source, title, body);
}

function classify(name: string, modulename?: string): string {
  const s = `${name} ${modulename ?? ""}`.toLowerCase();
  if (/(exam|final|midterm|test)/.test(s)) return "exam";
  if (/(assign|quiz|submission|due|report|essay|dropbox)/.test(s)) return "deadline";
  if (/(lecture|tutorial|lab|seminar|class)/.test(s)) return "class";
  return "deadline";
}

/** Strip HTML tags/entities from Moodle intro text into readable plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Ensure every assignment with a due date shows on the calendar — but skip ones
 * the Moodle calendar feed already covers (same course, within a day), so
 * deadlines aren't listed twice.
 */
function materialiseAssignmentEvents(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, course_id, title, url, due_at FROM assignments WHERE due_at IS NOT NULL")
    .all() as { id: string; course_id: string | null; title: string; url: string | null; due_at: string }[];
  const dayMs = 86_400_000;
  for (const a of rows) {
    const dup = db
      .prepare(
        "SELECT start_at FROM events WHERE source = 'ical' AND (course_id IS ? OR course_id = ?)",
      )
      .all(a.course_id, a.course_id) as { start_at: string }[];
    const due = new Date(a.due_at).getTime();
    const covered = dup.some((e) => Math.abs(new Date(e.start_at).getTime() - due) < dayMs);
    if (covered) continue;
    db.prepare(
      `INSERT INTO events (id, course_id, title, kind, source, start_at, url)
       VALUES (?, ?, ?, 'deadline', 'assignment', ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, start_at=excluded.start_at, url=excluded.url, updated_at=datetime('now')`,
    ).run("assign-evt:" + a.id, a.course_id, "Due: " + a.title, a.due_at, a.url);
  }

  // Opening dates as their own events.
  const opens = db
    .prepare("SELECT id, course_id, title, url, open_at FROM assignments WHERE open_at IS NOT NULL")
    .all() as { id: string; course_id: string | null; title: string; url: string | null; open_at: string }[];
  for (const a of opens) {
    db.prepare(
      `INSERT INTO events (id, course_id, title, kind, source, start_at, url)
       VALUES (?, ?, ?, 'open', 'assignment', ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, start_at=excluded.start_at, url=excluded.url, updated_at=datetime('now')`,
    ).run("assign-open:" + a.id, a.course_id, "Opens: " + a.title, a.open_at, a.url);
  }
}

// --- Moodle response shapes (only the fields we use) ---
interface MoodleCourse {
  id: number;
  shortname: string;
  fullname: string;
  startdate: number;
  enddate: number;
  visible?: number;
}
interface MoodleAssignCourse {
  id: number;
  assignments: {
    id: number;
    cmid: number;
    name: string;
    intro: string;
    duedate: number;
    allowsubmissionsfromdate?: number;
    introattachments?: { filename: string; fileurl: string }[];
  }[];
}
interface MoodleCalEvent {
  id: number;
  name: string;
  timesort: number;
  url?: string;
  modulename?: string;
  course?: { id: number };
}
interface MoodleSection {
  name?: string;
  summary?: string;
  modules?: MoodleModule[];
}
interface MoodleModule {
  id: number;
  name: string;
  modname: string;
  url?: string;
  description?: string;
  contents?: { type: string; filename: string; fileurl: string; mimetype?: string }[];
}
