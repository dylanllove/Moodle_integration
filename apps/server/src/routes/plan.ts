import type { FastifyInstance } from "fastify";
import { buildPlan, markDone } from "../plan.js";

export async function registerPlanRoutes(app: FastifyInstance): Promise<void> {
  /** Today's plan, or any day's. */
  app.get<{ Querystring: { date?: string } }>("/api/plan", async (req) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? "") ? req.query.date : undefined;
    return buildPlan(date);
  });

  /** Tick something off, or put it back. */
  app.post<{ Body: { key?: string; date?: string; done?: boolean } }>(
    "/api/plan/done",
    async (req, reply) => {
      const key = (req.body?.key ?? "").trim();
      if (!key) return reply.code(400).send({ error: "key is required." });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date ?? "")
        ? req.body!.date!
        : new Date().toISOString().slice(0, 10);
      markDone(date, key, req.body?.done !== false);
      return { ok: true, ...buildPlan(date) };
    },
  );
}
