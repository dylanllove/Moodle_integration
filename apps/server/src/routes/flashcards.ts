import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";
import {
  createDeck,
  deckCards,
  dueCards,
  generateFrom,
  listDecks,
  reviewCard,
  toAnkiCsv,
  toQuizlet,
  type DeckSource,
} from "../decks.js";
import { intakeFor } from "../card-schedule.js";

const SOURCES = ["lecture", "material", "note", "course"] as const;

export async function registerFlashcardRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get<{ Querystring: { course_id?: string } }>("/api/decks", async (req) => ({
    decks: listDecks(req.query.course_id),
    // Why today's number is what it is — otherwise a queue that shrank from 438
    // to 50 looks like cards went missing.
    intake: req.query.course_id ? intakeFor(req.query.course_id) : null,
    intakeByCourse: getDb()
      .prepare("SELECT DISTINCT course_id FROM decks WHERE course_id IS NOT NULL")
      .all()
      .map((r) => intakeFor((r as { course_id: string }).course_id)),
  }));

  app.get<{ Params: { id: string } }>("/api/decks/:id", async (req, reply) => {
    const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(req.params.id);
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    const cards = db
      .prepare("SELECT id, q, a, box, due_at, reviews, lapses FROM cards WHERE deck_id = ? ORDER BY rowid")
      .all(req.params.id);
    return { deck, cards };
  });

  /** Generate a deck from a lecture, a downloaded file, a note, or a whole course. */
  app.post<{ Body: { type?: string; id?: string; count?: number } }>(
    "/api/decks/generate",
    async (req, reply) => {
      const type = req.body?.type;
      const id = req.body?.id;
      if (!id || !SOURCES.includes(type as (typeof SOURCES)[number])) {
        return reply
          .code(400)
          .send({ error: `Pass an id and a type of: ${SOURCES.join(", ")}.` });
      }
      try {
        const made = await generateFrom({ type, id } as DeckSource, { count: req.body?.count });
        if (!made) {
          return reply.code(400).send({
            error:
              "Not enough material to make cards from yet — transcribe the lecture or sync course files first.",
          });
        }
        return { ok: true, ...made };
      } catch (e) {
        return reply.code(500).send({ error: String(e instanceof Error ? e.message : e) });
      }
    },
  );

  app.post<{ Body: { title?: string; course_id?: string | null; cards?: { q: string; a: string }[] } }>(
    "/api/decks",
    async (req, reply) => {
      const cards = req.body?.cards ?? [];
      if (!cards.length) return reply.code(400).send({ error: "No cards supplied." });
      const made = createDeck({
        title: req.body?.title?.trim() || "Untitled deck",
        course_id: req.body?.course_id ?? null,
        source: "manual",
        cards,
      });
      return { ok: true, ...made };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/decks/:id", async (req) => {
    db.prepare("DELETE FROM decks WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  // --- Review -------------------------------------------------------------
  app.get<{ Querystring: { deck_id?: string; course_id?: string; limit?: string } }>(
    "/api/review/queue",
    async (req) => {
      const cards = dueCards({
        deck_id: req.query.deck_id,
        course_id: req.query.course_id,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      const total = (
        db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }
      ).n;
      return { cards, total };
    },
  );

  app.post<{ Params: { id: string }; Body: { got?: boolean } }>(
    "/api/review/:id",
    async (req, reply) => {
      const r = reviewCard(req.params.id, req.body?.got === true);
      if (!r) return reply.code(404).send({ error: "card not found" });
      return { ok: true, ...r };
    },
  );

  // --- Exports ------------------------------------------------------------
  /**
   * Quizlet import text. Quizlet has no public API for creating sets, so this is
   * the supported route: copy, then paste into Quizlet → Create → Import.
   */
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/decks/:id/quizlet",
    async (req, reply) => {
      const cards = deckCards(req.params.id);
      if (!cards.length) return reply.code(404).send({ error: "deck is empty" });
      const body = toQuizlet(cards);
      if (req.query.download === "1") {
        reply.header("content-type", "text/plain; charset=utf-8");
        reply.header("content-disposition", `attachment; filename="${filename(req.params.id)}-quizlet.txt"`);
        return body;
      }
      return { text: body, cards: cards.length };
    },
  );

  app.get<{ Params: { id: string } }>("/api/decks/:id/anki.csv", async (req, reply) => {
    const cards = deckCards(req.params.id);
    if (!cards.length) return reply.code(404).send({ error: "deck is empty" });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${filename(req.params.id)}-anki.csv"`);
    return toAnkiCsv(cards);
  });

  function filename(deckId: string): string {
    const row = db.prepare("SELECT title FROM decks WHERE id = ?").get(deckId) as
      | { title: string }
      | undefined;
    return (row?.title ?? "deck").replace(/[^\w.-]+/g, "_").slice(0, 60);
  }
}
