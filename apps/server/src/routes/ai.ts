import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";
import {
  hasApiKey,
  summariseLecture,
  transcriptToNotes,
  explain,
  flashcards,
  indexAll,
  outlineAssignment,
  draftSection,
  feedbackOnDraft,
  type AssignmentContext,
} from "@uni/ai";

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Guard: fail fast with a clear message if no API key is configured.
  // reindex is pure local lexical indexing and needs no key, so it's exempt.
  app.addHook("preHandler", async (req, reply) => {
    const needsKey = req.url.startsWith("/api/ai/") && !req.url.startsWith("/api/ai/reindex");
    if (needsKey && !hasApiKey()) {
      reply.code(400).send({ error: "OPENAI_API_KEY is not set. Add it to your .env file." });
    }
  });

  app.post<{ Body: { lecture_id: string; mode?: "summary" | "notes" } }>(
    "/api/ai/summarise-lecture",
    async (req, reply) => {
      const t = db
        .prepare("SELECT text FROM transcripts WHERE lecture_id = ? AND status = 'done'")
        .get(req.body.lecture_id) as { text: string | null } | undefined;
      if (!t?.text) return reply.code(400).send({ error: "No completed transcript for this lecture." });
      const lec = db.prepare("SELECT title FROM lectures WHERE id = ?").get(req.body.lecture_id) as
        | { title: string }
        | undefined;
      const markdown =
        req.body.mode === "notes"
          ? await transcriptToNotes(t.text)
          : await summariseLecture(t.text, lec?.title);
      return { markdown };
    },
  );

  app.post<{ Body: { text?: string; note_id?: string } }>("/api/ai/flashcards", async (req) => {
    const text = req.body.text ?? noteText(req.body.note_id);
    return { cards: await flashcards(text) };
  });

  app.post<{ Body: { text: string; context?: string } }>("/api/ai/explain", async (req) => {
    return { markdown: await explain(req.body.text, req.body.context) };
  });

  app.post("/api/ai/reindex", async () => indexAll());

  // --- Assignment assistant ---
  app.post<{ Body: { assignment_id: string } }>("/api/ai/outline", async (req, reply) => {
    const ctx = assignmentCtx(req.body.assignment_id);
    if (!ctx) return reply.code(404).send({ error: "assignment not found" });
    return { markdown: await outlineAssignment(ctx) };
  });

  app.post<{ Body: { assignment_id: string; section: string } }>(
    "/api/ai/draft",
    async (req, reply) => {
      const ctx = assignmentCtx(req.body.assignment_id);
      if (!ctx) return reply.code(404).send({ error: "assignment not found" });
      return { markdown: await draftSection(ctx, req.body.section) };
    },
  );

  app.post<{ Body: { assignment_id: string; draft: string } }>(
    "/api/ai/feedback",
    async (req, reply) => {
      const ctx = assignmentCtx(req.body.assignment_id);
      if (!ctx) return reply.code(404).send({ error: "assignment not found" });
      return { markdown: await feedbackOnDraft(ctx, req.body.draft) };
    },
  );

  function noteText(noteId?: string): string {
    if (!noteId) return "";
    const n = db.prepare("SELECT title, body FROM notes WHERE id = ?").get(noteId) as
      | { title: string; body: string }
      | undefined;
    return n ? `${n.title}\n${n.body}` : "";
  }

  function assignmentCtx(id: string): AssignmentContext | null {
    const a = db.prepare("SELECT title, brief, course_id FROM assignments WHERE id = ?").get(id) as
      | { title: string; brief: string | null; course_id: string | null }
      | undefined;
    if (!a) return null;
    return { title: a.title, brief: a.brief ?? "", courseId: a.course_id };
  }
}
