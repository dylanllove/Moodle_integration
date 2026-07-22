import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { getDb } from "@uni/db";
import {
  moodleApiConfigured,
  getCourseForumPosts,
  getCourseSlideFiles,
  courseNumericId,
} from "@uni/lms";
import { extractSlideText } from "../extract.js";

const MAX_SLIDES_PER_COURSE = 40;

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  // Preview / fetch one course's markdown.
  app.get<{ Params: { id: string } }>("/api/courses/:id/markdown", async (req, reply) => {
    const md = await buildCourseMarkdown(req.params.id);
    if (!md) return reply.code(404).send({ error: "course not found" });
    reply.header("content-type", "text/markdown; charset=utf-8");
    return md.markdown;
  });

  // Download one course as a .md file.
  app.get<{ Params: { id: string } }>("/api/export/course/:id", async (req, reply) => {
    const md = await buildCourseMarkdown(req.params.id);
    if (!md) return reply.code(404).send({ error: "course not found" });
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${md.filename}"`);
    return md.markdown;
  });

  // Download one lecture's transcript / slide text as .md
  app.get<{ Params: { id: string } }>("/api/export/lecture/:id", async (req, reply) => {
    const row = getDb()
      .prepare(
        `SELECT l.title, l.provider, t.text FROM lectures l
         LEFT JOIN transcripts t ON t.lecture_id = l.id WHERE l.id = ?`,
      )
      .get(req.params.id) as { title: string; provider: string | null; text: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "lecture not found" });
    const md = `# ${row.title}\n\n${row.text ?? "_(not transcribed yet)_"}\n`;
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${row.title.replace(/[^\w.-]+/g, "_")}.md"`);
    return md;
  });

  // Download ALL active courses as a single zip of .md files.
  app.get("/api/export/all", async (_req, reply) => {
    const courses = getDb()
      .prepare("SELECT id FROM courses WHERE active = 1 ORDER BY name")
      .all() as { id: string }[];
    const zip = new JSZip();
    for (const c of courses) {
      const md = await buildCourseMarkdown(c.id);
      if (md) zip.file(md.filename, md.markdown);
    }
    zip.file(
      "README.md",
      `# Uni Study export\n\nExported ${new Date().toISOString()}.\nOne markdown file per active course — drop any of them into an LLM to study.\n`,
    );
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="uni-study-export.zip"`);
    return buf;
  });
}

interface CourseMd {
  filename: string;
  markdown: string;
}

async function buildCourseMarkdown(courseId: string): Promise<CourseMd | null> {
  const db = getDb();
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId) as
    | { id: string; name: string; code: string | null }
    | undefined;
  if (!course) return null;

  const out: string[] = [];
  out.push(`# ${course.name}${course.code ? ` (${course.code})` : ""}`);
  out.push(`\n_Exported from Uni Study on ${new Date().toLocaleString()}_\n`);

  // Assignments
  const assignments = db
    .prepare("SELECT * FROM assignments WHERE course_id = ? ORDER BY due_at IS NULL, due_at")
    .all(courseId) as any[];
  if (assignments.length) {
    out.push(`\n## Assignments\n`);
    for (const a of assignments) {
      const due = a.due_at ? new Date(a.due_at).toLocaleString() : "no due date";
      const open = a.open_at ? `, opens ${new Date(a.open_at).toLocaleString()}` : "";
      out.push(`### ${a.title}\n_Due: ${due}${open}_\n\n${a.brief || "(no brief)"}\n`);
    }
  }

  // Lecture transcripts
  const lectures = db
    .prepare(
      `SELECT l.title, t.text, t.status FROM lectures l
       LEFT JOIN transcripts t ON t.lecture_id = l.id WHERE l.course_id = ?`,
    )
    .all(courseId) as { title: string; text: string | null; status: string | null }[];
  const transcribed = lectures.filter((l) => l.text);
  if (transcribed.length) {
    out.push(`\n## Lecture transcripts\n`);
    for (const l of transcribed) out.push(`### ${l.title}\n\n${l.text}\n`);
  }

  // Notes the student wrote for this course
  const notes = db
    .prepare("SELECT title, body FROM notes WHERE course_id = ?")
    .all(courseId) as { title: string; body: string }[];
  if (notes.length) {
    out.push(`\n## My notes\n`);
    for (const n of notes) out.push(`### ${n.title}\n\n${n.body}\n`);
  }

  // Moodle-sourced material (slides + forum) — only when API is configured.
  const numId = courseNumericId(courseId);
  if (moodleApiConfigured() && numId != null) {
    // Slide text
    try {
      const slides = (await getCourseSlideFiles(numId)).slice(0, MAX_SLIDES_PER_COURSE);
      const chunks: string[] = [];
      for (const s of slides) {
        try {
          const text = await extractSlideText(s.url, s.mimetype);
          if (text) chunks.push(`### ${s.name}\n\n${text}\n`);
        } catch {
          chunks.push(`### ${s.name}\n\n_(could not extract text)_\n`);
        }
      }
      if (chunks.length) out.push(`\n## Lecture slides (extracted text)\n\n${chunks.join("\n")}`);
    } catch {
      /* skip slides */
    }

    // Forum posts
    try {
      const posts = await getCourseForumPosts(numId);
      if (posts.length) {
        out.push(`\n## Forum posts & announcements\n`);
        for (const p of posts) {
          const when = p.date ? new Date(p.date).toLocaleDateString() : "";
          out.push(`### ${p.subject}\n_${p.author}${when ? ` · ${when}` : ""} · ${p.forum}_\n\n${p.text}\n`);
        }
      }
    } catch {
      /* skip forum */
    }
  }

  const filename = `${(course.code || course.name).replace(/[^\w.-]+/g, "_")}.md`;
  return { filename, markdown: out.join("\n") };
}
