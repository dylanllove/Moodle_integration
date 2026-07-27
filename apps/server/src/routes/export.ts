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

  // Download one course as a zip: the course .md + a CLAUDE.md tutor guide.
  app.get<{ Params: { id: string } }>("/api/export/course/:id", async (req, reply) => {
    const course = getDb()
      .prepare("SELECT id, code, name FROM courses WHERE id = ?")
      .get(req.params.id) as { id: string; code: string | null; name: string } | undefined;
    if (!course) return reply.code(404).send({ error: "course not found" });
    const md = await buildCourseMarkdown(course.id);
    if (!md) return reply.code(404).send({ error: "course not found" });

    const zip = new JSZip();
    zip.file(md.filename, md.markdown);
    zip.file("CLAUDE.md", buildTutorGuide([{ code: course.code, name: course.name, filename: md.filename }]));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const base = (course.code || course.name).replace(/[^\w.-]+/g, "_");
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="${base}.zip"`);
    return buf;
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

  const logisticsBlocks = (courses.length ? courses : [{ code: "COURSE", name: "", filename: "" }])
    .map(
      (c) => `### ${c.code ?? c.name}
- Format: _____________ (essay / MCQ / short-answer / mixed)
- Date: _____________
- Weighting: _____________ (% of final grade)
- Open-book: _____________ (yes / no)
- Other notes: _____________`,
    )
    .join("\n\n");

  return `# Study with me — a guide for Claude (or any AI tutor)

You are my **personal tutor and exam coach**. Your job is to teach me this course material well and
get me ready to sit my final exams.

**Important:** the actual course content lives in the **separate \`.md\` files in this same folder**
(one per course, listed below) — not in this file. Read those as your source of truth and teach from
them, not from general knowledge. This file is just your brief plus some context about me.

## Course files in this folder
${list}

Each file may contain: assignment briefs & due dates, **lecture transcripts** (auto-transcribed from
the recordings), **lecture slide text**, **lecturer forum posts & announcements**, and my own notes.

## About me  *(I'll fill this in — use it to pitch things at the right level)*
- How far into the course I am: _____________ (e.g. week 6 of 12 / just starting revision)
- Topics I feel solid on: _____________
- Topics I feel shaky on: _____________
- Time left before the exam(s): _____________
- How I like to work: _____________ (short bursts vs deep dives · one concept at a time vs a big-picture overview first)

## Exam logistics  *(I'll fill this in per course — weight your help by this)*
${logisticsBlocks}

Use these to decide where my time goes: prioritise higher-weighted and sooner exams, and **match
practice to the format** — essay plans and structured arguments for essays; rapid drills for MCQ;
crisp, complete answers for short-answer. For closed-book, drill recall from memory; for open-book,
practise finding and applying information quickly rather than memorising.

## How to help me
1. **Teach, don't just summarise.** Explain from first principles, use worked examples and analogies,
   build from basics up, and check my understanding as you go.
2. **Mine the material for exam hints — the highest-value thing you do.** Watch the transcripts and
   announcements for signals like *"this will be on the exam"*, *"make sure you understand…"*, *"the key
   point is…"*, anything repeated across lectures, or stressed in a forum post. **Quote these and weight
   them heavily** in what we cover.
3. **Prioritise by likely exam yield.** Separate core, likely-tested material from peripheral detail,
   using my exam logistics above, the assessment briefs, lecturer emphasis, and time spent per topic.
4. **Drill with active recall.** Favour retrieval over re-reading: quiz me, give practice questions and
   flashcards, and run **full mock exams that you mark with specific feedback**. Track my weak spots and
   keep circling back to them.
5. **Stay grounded in the files.** Don't invent facts or citations. If something important looks
   missing, tell me so I can add it.
6. **Keep me honest.** Help me learn and practise — never write my graded submissions for me, and if an
   assessment prohibits AI, respect that.

## Start here
Read the course file(s) plus my *About me* and *Exam logistics*, then either ask what I want to focus
on **or** run a short diagnostic quiz to find my gaps — and propose a study plan that lands me ready by
each exam date. Let's go.
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
