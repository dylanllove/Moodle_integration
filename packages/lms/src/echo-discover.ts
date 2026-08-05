import type { BrowserContext } from "playwright";
import { getDb } from "@uni/db";
import { acquireEchoContext, persistEchoSession, withEchoLock } from "./echo360.js";
import { moodleWs, courseNumericId } from "./moodle-api.js";

const ORIGIN = "https://echo360.net.au";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DiscoveredSection {
  sectionId: string;
  courseId: string | null;
  courseCode: string | null;
  label: string;
  /** How we established the mapping — `lti` is authoritative, `enrollments` is a name match. */
  via: "lti" | "enrollments";
}

export interface DiscoveryResult {
  found: DiscoveredSection[];
  notes: string[];
}

interface CourseRow {
  id: string;
  code: string;
}

function activeCourses(): CourseRow[] {
  return getDb()
    .prepare("SELECT id, code FROM courses WHERE active = 1 ORDER BY code")
    .all() as unknown as CourseRow[];
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 140);

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Depth-first hunt for a `sectionId` that looks like a GUID. */
function findSectionId(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findSectionId(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const rec = node as Record<string, unknown>;
  if (typeof rec.sectionId === "string" && GUID_RE.test(rec.sectionId)) return rec.sectionId;
  for (const v of Object.values(rec)) {
    const hit = findSectionId(v);
    if (hit) return hit;
  }
  return null;
}

interface LaunchData {
  endpoint: string;
  parameters: { name: string; value: string }[];
}

/**
 * Perform a Moodle LTI launch inside the authenticated Echo context and work out
 * which Echo section it lands on.
 *
 * This is the authoritative mapping: we launched *from* a known Moodle course, so
 * whatever section comes back belongs to that course. No name matching, and no
 * chance of the stale-label problem where a section says one course and points at
 * another.
 */
async function sectionFromLtiLaunch(
  ctx: BrowserContext,
  toolId: number,
): Promise<{ sectionId: string | null; landed: string; echo: boolean }> {
  const d = await moodleWs<LaunchData>("mod_lti_get_tool_launch_data", { toolid: toolId });
  if (!/echo360/i.test(d.endpoint ?? "")) return { sectionId: null, landed: d.endpoint ?? "", echo: false };

  const fields = (d.parameters ?? [])
    .map((p) => `<input type="hidden" name="${escapeAttr(p.name)}" value="${escapeAttr(String(p.value))}">`)
    .join("");

  const page = await ctx.newPage();
  const navigated: string[] = [];
  const payloads: unknown[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigated.push(f.url());
  });
  page.on("response", async (r) => {
    if (!/echo360\.net/i.test(r.url())) return;
    if (!/json/i.test(r.headers()["content-type"] ?? "")) return;
    try {
      payloads.push(await r.json());
    } catch {
      /* not all JSON-typed responses parse; ignore */
    }
  });

  try {
    // The launch is an OAuth1-signed POST, so it has to be submitted as a form —
    // and the signature has a short life, hence launching straight after asking
    // Moodle for the parameters.
    await page.setContent(
      `<!doctype html><body onload="document.forms[0].submit()">` +
        `<form action="${escapeAttr(d.endpoint)}" method="POST">${fields}</form></body>`,
    );
    await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const landed = page.url();

    // Shape 1 — the link opens the section itself: the id is in the path.
    const fromUrl = [...navigated, landed]
      .map((u) => u.match(/\/section\/([0-9a-f-]{36})/i)?.[1])
      .find(Boolean);
    if (fromUrl) return { sectionId: fromUrl, landed, echo: true };

    // Shape 2 — the link is a deep link to one lesson's player. There's no
    // section in the URL, so take one from whatever the player fetched on its way
    // in; if that comes up empty the caller falls back to the enrolment list.
    return { sectionId: findSectionId(payloads), landed, echo: true };
  } finally {
    await page.close().catch(() => {});
  }
}

interface EnrolledSection {
  sectionId: string;
  sectionName: string | null;
  courseName: string | null;
}

/**
 * Read the section list behind Echo's own "Courses" page.
 *
 * Worth knowing: this list does *not* include sections you only ever reach by
 * launching them from Moodle, so it can't be the only source of truth — it's the
 * fallback for links that resolve to a single lesson rather than a section.
 */
async function listEnrolledSections(ctx: BrowserContext): Promise<EnrolledSection[]> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${ORIGIN}/user/enrollments`, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
    const raw = await page.evaluate(async () => {
      const r = await fetch("/user/enrollments", { headers: { accept: "application/json" } });
      return r.ok ? await r.text() : "";
    });
    if (!raw) return [];
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    const out = new Map<string, EnrolledSection>();
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== "object") return;
      const rec = n as Record<string, any>;
      const id = rec.sectionId ?? rec.id;
      if (typeof id === "string" && GUID_RE.test(id) && (rec.sectionName || rec.courseCode)) {
        if (!out.has(id))
          out.set(id, {
            sectionId: id,
            sectionName: rec.sectionName ?? rec.courseCode ?? null,
            courseName: rec.courseName ?? null,
          });
      }
      Object.values(rec).forEach(visit);
    };
    visit(data);
    return [...out.values()];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Work out which Echo360 section belongs to each active course, without the user
 * ever having to find a GUID.
 *
 * Two passes, because neither source is complete on its own:
 *   1. Launch each course's Echo link on Moodle. Authoritative, and the only way
 *      to find sections missing from Echo's own course list.
 *   2. Match Echo's enrolment list against course codes, for courses whose Moodle
 *      link is a deep link to a single lesson and so yields no section.
 */
export async function discoverEchoSections(): Promise<DiscoveryResult> {
  const courses = activeCourses();
  const notes: string[] = [];
  const found = new Map<string, DiscoveredSection>();

  return withEchoLock(async () => {
    const acquired = await acquireEchoContext();
    const { ctx, done } = acquired;
    const unresolved: CourseRow[] = [];
    try {
      // ---- Pass 1: the Moodle LTI link for each course.
      for (const c of courses) {
        const num = courseNumericId(c.id);
        if (num == null) continue;
        let contents: any[];
        try {
          contents = await moodleWs<any[]>("core_course_get_contents", { courseid: num });
        } catch (e) {
          notes.push(`${c.code}: couldn't read Moodle contents — ${short(e)}`);
          unresolved.push(c);
          continue;
        }
        const ltis = (contents ?? []).flatMap((s: any) =>
          (s.modules ?? []).filter((m: any) => m.modname === "lti"),
        );
        if (!ltis.length) {
          notes.push(`${c.code}: no Echo360 link on its Moodle page — nothing to discover.`);
          continue;
        }
        let resolved = false;
        for (const m of ltis) {
          let res;
          try {
            res = await sectionFromLtiLaunch(ctx, m.instance);
          } catch (e) {
            notes.push(`${c.code}: Echo link "${m.name}" wouldn't launch — ${short(e)}`);
            continue;
          }
          if (!res.echo) continue;
          if (res.sectionId) {
            found.set(res.sectionId, {
              sectionId: res.sectionId,
              courseId: c.id,
              courseCode: c.code,
              label: `${c.code} (via Moodle link)`,
              via: "lti",
            });
            resolved = true;
            break;
          }
        }
        if (!resolved) unresolved.push(c);
      }

      // ---- Pass 2: Echo's own enrolment list, for whatever pass 1 couldn't pin down.
      if (unresolved.length) {
        let enrolled: EnrolledSection[] = [];
        try {
          enrolled = await listEnrolledSections(ctx);
        } catch (e) {
          notes.push(`Couldn't read your Echo360 course list — ${short(e)}`);
        }
        for (const c of unresolved) {
          const hit = enrolled.find(
            (e) => (e.sectionName ?? "").trim().toLowerCase() === c.code.toLowerCase(),
          );
          if (!hit) {
            notes.push(
              `${c.code}: its Moodle link opens a single lesson, and no matching section in your Echo course list — add it by hand if you know the URL.`,
            );
            continue;
          }
          if (found.has(hit.sectionId)) continue;
          found.set(hit.sectionId, {
            sectionId: hit.sectionId,
            courseId: c.id,
            courseCode: c.code,
            label: `${c.code} (matched in Echo course list)`,
            via: "enrollments",
          });
        }
      }

      return { found: [...found.values()], notes };
    } finally {
      await persistEchoSession(ctx).catch(() => {});
      await done();
    }
  });
}
