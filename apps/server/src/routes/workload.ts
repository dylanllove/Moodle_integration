import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getDb } from "@uni/db";
import { syncPersonal } from "@uni/lms";
import { computeWorkload } from "../workload.js";

interface CommitmentBody {
  title?: string;
  kind?: string;
  weekdays?: number[] | null;
  start_time?: string | null;
  hours?: number;
  start_at?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  notes?: string | null;
}

const KINDS = ["work", "sport", "social", "care", "travel", "other"];

export async function registerWorkloadRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get<{ Querystring: { weeks?: string } }>("/api/workload", async (req) => {
    const weeks = Math.min(30, Math.max(4, Number(req.query.weeks ?? 14) || 14));
    return computeWorkload(weeks);
  });

  // --- Life outside class -------------------------------------------------
  app.get("/api/commitments", async () =>
    db.prepare("SELECT * FROM commitments ORDER BY start_time, title").all(),
  );

  app.post<{ Body: CommitmentBody }>("/api/commitments", async (req, reply) => {
    const b = req.body ?? {};
    const title = (b.title ?? "").trim();
    if (!title) return reply.code(400).send({ error: "Give the commitment a name." });
    const recurring = Array.isArray(b.weekdays) && b.weekdays.length > 0;
    if (!recurring && !b.start_at) {
      return reply
        .code(400)
        .send({ error: "Pick either the days it repeats on, or a single date and time." });
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO commitments (id, title, kind, weekdays, start_time, hours, start_at, from_date, to_date, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      title,
      KINDS.includes(b.kind ?? "") ? b.kind! : "other",
      recurring ? JSON.stringify(b.weekdays) : null,
      recurring ? (b.start_time ?? "18:00") : null,
      hoursOf(b.hours),
      recurring ? null : b.start_at!,
      b.from_date || null,
      b.to_date || null,
      b.notes || null,
    );
    syncPersonal();
    return db.prepare("SELECT * FROM commitments WHERE id = ?").get(id);
  });

  app.put<{ Params: { id: string }; Body: CommitmentBody }>(
    "/api/commitments/:id",
    async (req, reply) => {
      const existing = db.prepare("SELECT * FROM commitments WHERE id = ?").get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!existing) return reply.code(404).send({ error: "not found" });
      const b = req.body ?? {};
      const recurring = b.weekdays === undefined ? undefined : (b.weekdays ?? []).length > 0;

      db.prepare(
        `UPDATE commitments SET title = ?, kind = ?, weekdays = ?, start_time = ?, hours = ?,
           start_at = ?, from_date = ?, to_date = ?, notes = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        (b.title ?? (existing.title as string)).trim(),
        KINDS.includes(b.kind ?? "") ? b.kind! : (existing.kind as string),
        recurring === undefined
          ? (existing.weekdays as string | null)
          : recurring
            ? JSON.stringify(b.weekdays)
            : null,
        b.start_time !== undefined ? b.start_time : (existing.start_time as string | null),
        b.hours !== undefined ? hoursOf(b.hours) : (existing.hours as number),
        b.start_at !== undefined ? b.start_at : (existing.start_at as string | null),
        b.from_date !== undefined ? b.from_date || null : (existing.from_date as string | null),
        b.to_date !== undefined ? b.to_date || null : (existing.to_date as string | null),
        b.notes !== undefined ? b.notes || null : (existing.notes as string | null),
        req.params.id,
      );
      syncPersonal();
      return db.prepare("SELECT * FROM commitments WHERE id = ?").get(req.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/commitments/:id", async (req) => {
    db.prepare("DELETE FROM commitments WHERE id = ?").run(req.params.id);
    syncPersonal();
    return { ok: true };
  });

  /** Re-expand recurring commitments (also runs on every launch). */
  app.post("/api/commitments/rebuild", async () => ({ ok: true, ...syncPersonal() }));
}

function hoursOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(24, n) : 1;
}
