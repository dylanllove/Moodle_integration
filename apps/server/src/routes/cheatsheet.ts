import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getDb } from "@uni/db";
import {
  hasApiKey,
  cheatSheet,
} from "@uni/ai";
import {
  moodleApiConfigured,
  getCourseForumPosts,
  getCourseSlideFiles,
  courseNumericId,
} from "@uni/lms";
import { extractSlideText } from "../extract.js";

// Keep the AI input within a sensible token budget (~40k tokens).
const CHAR_BUDGET = 150_000;

export async function registerCheatsheetRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.post<{ Body: { course_id: string } }>("/api/ai/cheatsheet", async (req, reply) => {
    if (!hasApiKey()) return reply.code(400).send({ error: "OPENAI_API_KEY is not set." });
    const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(req.body.course_id) as
      | { id: string; name: string; code: string | null }
      | undefined;
    if (!course) return reply.code(404).send({ error: "course not found" });

    const corpus = await gatherCorpus(course.id);
    if (!corpus.trim()) {
      return reply.code(400).send({ error: "No course material found yet — sync first." });
    }

    const markdown = await cheatSheet(course.name, corpus);

    // Save as a course-linked note so it's reusable + downloadable.
    const noteId = randomUUID();
    db.prepare(
      "INSERT INTO notes (id, course_id, title, body) VALUES (?,?,?,?)",
    ).run(noteId, course.id, `Cheat sheet — ${course.code || course.name}`, markdown);

    return { ok: true, note_id: noteId, markdown };
  });
}

/** Assemble course material within a character budget: briefs + transcripts +
 * forum posts (high signal for hints) + slide text (fills remaining budget). */
async function gatherCorpus(courseId: string): Promise<string> {
  const db = getDb();
  const parts: string[] = [];
  let budget = CHAR_BUDGET;
  const add = (label: string, text: string) => {
    if (!text || budget <= 0) return;
    const slice = text.slice(0, budget);
    parts.push(`\n## ${label}\n${slice}`);
    budget -= slice.length;
  };

  const assignments = db
    .prepare("SELECT title, brief FROM assignments WHERE course_id = ?")
    .all(courseId) as { title: string; brief: string | null }[];
  add(
    "Assignment briefs",
    assignments.map((a) => `### ${a.title}\n${a.brief ?? ""}`).join("\n\n"),
  );

  const transcripts = db
    .prepare(
      `SELECT l.title, t.text FROM lectures l JOIN transcripts t ON t.lecture_id = l.id
       WHERE l.course_id = ? AND t.text IS NOT NULL`,
    )
    .all(courseId) as { title: string; text: string }[];
  add("Lecture transcripts / content", transcripts.map((t) => `### ${t.title}\n${t.text}`).join("\n\n"));

  // Slides and readings already on disk, in teaching order.
  const stored = db
    .prepare(
      `SELECT title, week, text FROM materials
       WHERE course_id = ? AND text IS NOT NULL AND length(text) > 200
       ORDER BY week IS NULL, week, title`,
    )
    .all(courseId) as { title: string; week: number | null; text: string }[];

  const numId = courseNumericId(courseId);
  if (moodleApiConfigured() && numId != null) {
    try {
      const posts = await getCourseForumPosts(numId);
      add(
        "Forum posts & announcements (watch for lecturer hints)",
        posts.map((p) => `### ${p.subject} — ${p.author}\n${p.text}`).join("\n\n"),
      );
    } catch {
      /* skip */
    }
    // Slides fill whatever budget remains (usually the bulk of the material).
    // Prefer the copies the file sync already downloaded and extracted: same
    // text, no round trip, and it still works when Moodle is down or the
    // student is offline. Only reach for the network if nothing's stored.
    if (budget > 2000 && !stored.length) {
      try {
        const slides = await getCourseSlideFiles(numId);
        const chunks: string[] = [];
        for (const s of slides) {
          if (budget <= 0) break;
          try {
            const text = await extractSlideText(s.url, s.mimetype);
            if (text) {
              const slice = text.slice(0, Math.max(0, budget));
              chunks.push(`### ${s.name}\n${slice}`);
              budget -= slice.length;
            }
          } catch {
            /* skip file */
          }
        }
        if (chunks.length) parts.push(`\n## Lecture slides\n${chunks.join("\n\n")}`);
      } catch {
        /* skip slides */
      }
    }
  }

  add(
    "Lecture slides & readings",
    stored
      .map((s) => `### ${s.week ? `Week ${s.week} — ` : ""}${s.title}\n${s.text}`)
      .join("\n\n"),
  );

  return parts.join("\n");
}
