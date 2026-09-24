import { getDb } from "@uni/db";
import { clock, type ChunkSource } from "@uni/ai";

/**
 * Where a retrieved chunk actually came from, in terms the student recognises.
 *
 * The index stores only a source type and an id; an answer that says "from your
 * material" is unverifiable, while one that says "COSC121 · Week 3 slides" can
 * be opened and checked. Everything the assistant cites resolves through here.
 */
export interface SourceRef {
  /** What to call it: "Lecture 4", "Week 03 · regression.pdf". */
  label: string;
  /** What sort of thing it is — the index lumps lectures and course prose together. */
  kind: "note" | "lecture" | "material" | "course-page";
  courseId: string | null;
  courseCode: string | null;
  /** In-app destination, deep-linked to the item where a page supports it. */
  to: string | null;
  /** Seconds into the lecture recording this came from, when known. */
  atSec: number | null;
  /** External destination (a Moodle page) when there's no in-app view. */
  href: string | null;
}

const courseCache = new Map<string, { code: string | null; url: string | null }>();

function course(id: string | null): { code: string | null; url: string | null } {
  if (!id) return { code: null, url: null };
  const hit = courseCache.get(id);
  if (hit) return hit;
  const row = getDb().prepare("SELECT code, url FROM courses WHERE id = ?").get(id) as
    | { code: string | null; url: string | null }
    | undefined;
  const val = { code: row?.code ?? null, url: row?.url ?? null };
  courseCache.set(id, val);
  return val;
}

/** Drop the cached course lookups — call after a sync rewrites the course list. */
export function resetSourceCache(): void {
  courseCache.clear();
}

/**
 * `at` is where in the source the chunk sits: seconds into a recording, or a
 * slide number for a deck — the label says which ("Lecture 4 · 14:37",
 * "Week 3 slides · slide 6") and the link opens it there.
 */
export function describeSource(
  sourceType: ChunkSource,
  sourceId: string,
  at: number | null = null,
): SourceRef | null {
  const db = getDb();

  if (sourceType === "note") {
    const n = db.prepare("SELECT title, course_id FROM notes WHERE id = ?").get(sourceId) as
      | { title: string; course_id: string | null }
      | undefined;
    if (!n) return null;
    const c = course(n.course_id);
    return {
      label: n.title || "Untitled note",
      kind: "note",
      courseId: n.course_id,
      courseCode: c.code,
      to: `/notes?note=${encodeURIComponent(sourceId)}`,
      atSec: null,
      href: null,
    };
  }

  if (sourceType === "material") {
    const m = db
      .prepare("SELECT title, week, course_id FROM materials WHERE id = ?")
      .get(sourceId) as { title: string; week: number | null; course_id: string | null } | undefined;
    if (!m) return null;
    const c = course(m.course_id);
    return {
      label: m.week ? `Week ${String(m.week).padStart(2, "0")} · ${m.title}` : m.title,
      kind: "material",
      courseId: m.course_id,
      courseCode: c.code,
      to: `/materials?open=${encodeURIComponent(sourceId)}`,
      atSec: null,
      href: null,
    };
  }

  const l =
    sourceType === "course_text"
      ? undefined
      : (db.prepare("SELECT title, course_id, provider FROM lectures WHERE id = ?").get(sourceId) as
          | { title: string; course_id: string | null; provider: string | null }
          | undefined);
  if (l) {
    const c = course(l.course_id);
    const slides = l.provider === "slides";
    const where = at == null ? "" : slides ? ` · slide ${at}` : ` · ${clock(at)}`;
    const atSec = at != null && !slides ? Math.floor(at) : null;
    return {
      label: `${l.title}${where}`,
      kind: "lecture",
      courseId: l.course_id,
      courseCode: c.code,
      to: `/lectures?lecture=${encodeURIComponent(sourceId)}${atSec != null ? `&t=${atSec}` : ""}`,
      atSec,
      href: null,
    };
  }

  const t = db
    .prepare("SELECT title, source, course_id FROM course_text WHERE id = ?")
    .get(sourceId) as
    | { title: string | null; source: string; course_id: string | null }
    | undefined;
  if (t) {
    const c = course(t.course_id);
    return {
      label: t.title || (t.source === "forum" ? "Forum post" : "Course page"),
      kind: "course-page",
      courseId: t.course_id,
      courseCode: c.code,
      to: null,
      atSec: null,
      href: c.url,
    };
  }

  return null;
}
