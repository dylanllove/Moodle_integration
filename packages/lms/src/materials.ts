import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, getDb, upsert } from "@uni/db";
import { moodleApiConfigured, moodleWs, withToken } from "./moodle-api.js";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** Skip anything bigger than this — course material shouldn't be a video file. */
const MAX_FILE_BYTES = 80 * 1024 * 1024;

/**
 * What counts as course material. Deliberately an allowlist: lecture *media*
 * is handled by the recordings pipeline, and pulling every stray image or
 * archive would turn the folder into noise.
 */
const KINDS: { kind: MaterialKind; ext: RegExp; mime?: RegExp }[] = [
  { kind: "slides", ext: /\.(pptx?|key|odp)$/i, mime: /presentation|powerpoint/i },
  { kind: "sheet", ext: /\.(xlsx?|ods)$/i, mime: /spreadsheet|excel/i },
  { kind: "data", ext: /\.(csv|tsv|json|ipynb|r|py|sql|m)$/i },
  { kind: "reading", ext: /\.(pdf|docx?|odt|rtf|txt|md|epub)$/i, mime: /pdf|msword|wordprocessing/i },
];

export type MaterialKind = "slides" | "reading" | "sheet" | "data" | "other";

export interface MaterialsResult {
  courses: number;
  found: number;
  downloaded: number;
  skipped: number;
  failed: number;
  root: string;
}

/** Optional hook so the caller (which owns the PDF/PPTX parsers) can index text. */
export type TextExtractor = (path: string, mimetype: string) => Promise<string>;

/** Root of the organised library: <data>/materials */
export function materialsRoot(): string {
  return join(dataDir(), "materials");
}

/**
 * Download every slide deck, reading and handout from the LMS and file it under
 * `materials/<COURSE>/Week NN/`.
 *
 * Re-runnable: a file is only fetched when it's new or its LMS timestamp moved,
 * so a launch-time sync costs almost nothing once the library is warm.
 */
export async function syncMaterials(opts: {
  courseId?: string;
  extractText?: TextExtractor;
} = {}): Promise<MaterialsResult> {
  const out: MaterialsResult = {
    courses: 0,
    found: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    root: materialsRoot(),
  };
  if (!moodleApiConfigured()) return out;

  const db = getDb();
  const courses = (
    opts.courseId
      ? db.prepare("SELECT id, code, name, start_date FROM courses WHERE id = ?").all(opts.courseId)
      : db.prepare("SELECT id, code, name, start_date FROM courses WHERE active = 1").all()
  ) as { id: string; code: string | null; name: string; start_date: string | null }[];

  for (const course of courses) {
    const numId = Number(course.id.match(/moodle:course:(\d+)/)?.[1] ?? NaN);
    if (!Number.isFinite(numId)) continue;

    let sections: MoodleSection[];
    try {
      sections = await moodleWs<MoodleSection[]>("core_course_get_contents", { courseid: numId });
    } catch {
      continue; // course we can't read; the rest still sync
    }
    if (!Array.isArray(sections)) continue;
    out.courses++;

    const courseDir = join(materialsRoot(), safeName(course.code || course.name));
    // Week 1 anchors on the course start date, so files with no "Week N" label
    // still land in the right folder from their upload date.
    const termStart = course.start_date ? new Date(course.start_date) : null;

    for (const section of sections) {
      const sectionWeek = weekFromText(section.name ?? "");
      for (const mod of section.modules ?? []) {
        const modWeek = weekFromText(mod.name ?? "");
        for (const file of mod.contents ?? []) {
          if (file.type !== "file" || !file.fileurl) continue;
          const kind = classifyFile(file.filename, file.mimetype ?? "");
          if (!kind) continue;
          out.found++;

          const week =
            sectionWeek ??
            modWeek ??
            weekFromText(file.filename) ??
            weekFromDate(file.timemodified, termStart);
          const id = `moodle:file:${mod.id}:${sha(file.filename)}`;
          const modifiedAt = file.timemodified
            ? new Date(file.timemodified * 1000).toISOString()
            : null;

          const existing = db
            .prepare("SELECT path, modified_at, text FROM materials WHERE id = ?")
            .get(id) as { path: string | null; modified_at: string | null; text: string | null } | undefined;

          const dir = join(courseDir, week ? `Week ${String(week).padStart(2, "0")}` : "Unsorted");
          const path = join(dir, safeName(file.filename));
          const fresh =
            existing?.path === path &&
            existing.modified_at === modifiedAt &&
            fileExists(path);

          let bytes = file.filesize ?? null;
          let text = existing?.text ?? null;
          if (fresh) {
            out.skipped++;
          } else if ((file.filesize ?? 0) > MAX_FILE_BYTES) {
            out.skipped++;
          } else {
            try {
              mkdirSync(dir, { recursive: true });
              const res = await fetch(withToken(file.fileurl)!);
              if (!res.ok) throw new Error(`${res.status}`);
              const buf = Buffer.from(await res.arrayBuffer());
              writeFileSync(path, buf);
              bytes = buf.byteLength;
              out.downloaded++;
              // Slides/readings become study material only once they're text.
              if (opts.extractText) {
                text = await opts.extractText(path, file.mimetype ?? "").catch(() => null);
              }
            } catch {
              out.failed++;
              continue;
            }
          }

          upsert(
            "materials",
            {
              id,
              course_id: course.id,
              week,
              section: section.name ?? null,
              module: mod.name ?? null,
              title: file.filename,
              kind,
              mimetype: file.mimetype ?? null,
              source_url: mod.url ?? null,
              path,
              bytes,
              modified_at: modifiedAt,
              text,
            },
            [
              "course_id", "week", "section", "module", "title", "kind",
              "mimetype", "source_url", "path", "bytes", "modified_at", "text",
            ],
          );
        }
      }
    }
  }
  return out;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Which bucket a file belongs in, or null when it isn't course material. */
function classifyFile(filename: string, mimetype: string): MaterialKind | null {
  for (const k of KINDS) {
    if (k.ext.test(filename) || (k.mime && mimetype && k.mime.test(mimetype))) return k.kind;
  }
  return null;
}

/**
 * Pull a teaching week out of a label. Courses write it a dozen ways
 * ("Week 3", "Wk3", "Topic 03", "Module 3", "W3") — all of them mean folder 3.
 */
export function weekFromText(text: string): number | null {
  const m = text.match(/\b(?:week|wk|w|topic|module|unit|lecture|lec)\s*[-_ ]?(\d{1,2})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 52 ? n : null;
}

/** Fall back to "which week of term was this uploaded in?". */
function weekFromDate(timemodified: number | undefined, termStart: Date | null): number | null {
  if (!timemodified || !termStart) return null;
  const weeks = Math.floor((timemodified * 1000 - termStart.getTime()) / (7 * 864e5)) + 1;
  return weeks >= 1 && weeks <= 52 ? weeks : null;
}

/** Filesystem-safe, but still readable — this folder is meant to be browsed. */
function safeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

interface MoodleSection {
  name?: string;
  modules?: {
    id: number;
    name: string;
    url?: string;
    contents?: {
      type: string;
      filename: string;
      fileurl: string;
      mimetype?: string;
      filesize?: number;
      timemodified?: number;
    }[];
  }[];
}
