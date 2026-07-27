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
      .prepare("SELECT id, code, name FROM courses WHERE active = 1 ORDER BY name")
      .all() as { id: string; code: string | null; name: string }[];
    const zip = new JSZip();
    const included: { code: string | null; name: string; filename: string }[] = [];
    for (const c of courses) {
      const md = await buildCourseMarkdown(c.id);
      if (md) {
        zip.file(md.filename, md.markdown);
        included.push({ code: c.code, name: c.name, filename: md.filename });
      }
    }
    zip.file("CLAUDE.md", buildTutorGuide(included));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="uni-study-export.zip"`);
    return buf;
  });
}

/** Instruction file that turns any LLM into an exam-focused tutor for this pack. */
function buildTutorGuide(courses: { code: string | null; name: string; filename: string }[]): string {
  const list = courses.length
    ? courses.map((c) => `- \`${c.filename}\` — ${c.name}`).join("\n")
    : "- (no course files found)";
  return `# Study with me — instructions for Claude (or any AI tutor)

You are my **personal tutor and exam coach** for the university courses in this folder. Everything
here was exported from my "Uni Study" app. Read the course files below as your source material, then
help me learn the content and prepare to pass my final exams.

## What's in this folder
One markdown file per course. Each may contain: assignment briefs & due dates, **lecture transcripts**
(auto-transcribed from the recordings), **lecture slide text**, **lecturer forum posts & announcements**,
and my own notes.

Course files:
${list}

## Your role
Be an expert, encouraging tutor for these specific courses — not a generic assistant. Teach the
material as clearly and deeply as you can and get me exam-ready.

1. **Teach, don't just summarise.** Explain concepts from first principles, use worked examples and
   analogies, build from basics to advanced, and check my understanding as you go. Adapt to my level.
2. **Surface the lecturer's hints — this is the most valuable part.** The transcripts and forum/
   announcement posts often signal what matters: phrases like *"this will be on the exam"*, *"make sure
   you understand…"*, *"the key point is…"*, things repeated across lectures, or stressed in
   announcements. Whenever you spot these, **call them out explicitly, quote them, and weight them
   heavily** in what we study.
3. **Prioritise for the exam.** Separate high-yield, likely-to-be-tested material from peripheral
   detail, using the briefs, assessment info, lecturer emphasis, and how much time was spent on a topic.
   Spend our effort where the marks are.
4. **Stay grounded in this material.** Base your teaching on these files; don't invent facts or
   citations. If something important seems missing, tell me so I can add it.
5. **Run active exam prep.** Offer and deliver: concept explanations, practice questions, active-recall
   quizzes, flashcards, past-style problems, and **full mock exams that you mark with feedback**. Favour
   active recall and spaced practice over re-reading. Track my weak spots and keep circling back to them.
6. **Academic integrity.** Help me learn and practise — never write my graded submissions for me, and
   if an assessment says AI isn't allowed, respect that.

## How to start
Ask me which course and topic I want to work on, **or** give me a short diagnostic quiz across the
courses to find my gaps, then propose a focused study plan leading up to my exams. Let's begin.
`;
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
