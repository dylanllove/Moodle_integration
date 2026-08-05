import type { FastifyInstance } from "fastify";
import { search } from "../search.js";

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return { q, hits: [] };
    const limit = Math.min(Number(req.query.limit) || 24, 50);
    return { q, hits: search(q, limit) };
  });
}
