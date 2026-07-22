import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";
import { complete, hasApiKey, MODEL_FAST } from "@uni/ai";

export async function registerAskRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { question: string; history?: { role: string; content: string }[] } }>(
    "/api/ai/ask",
    async (req, reply) => {
      if (!hasApiKey()) return reply.code(400).send({ error: "OPENAI_API_KEY is not set." });
      const question = (req.body.question ?? "").trim();
      if (!question) return reply.code(400).send({ error: "empty question" });

      const context = buildContext();
      const history = (req.body.history ?? [])
        .slice(-4)
        .map((m) => `${m.role === "user" ? "Q" : "A"}: ${m.content}`)
        .join("\n");

      const answer = await complete(
        `${history ? `Earlier in this chat:\n${history}\n\n` : ""}Question: ${question}`,
        {
          system:
            "You are a concise study assistant with access to the student's own university data below. " +
            "Answer ONLY from this data, briefly and directly (a sentence or a short list).\n" +
            "IMPORTANT about attendance: lectures at this university are recorded on Echo360 and are generally OPTIONAL to attend. " +
            "Do NOT call a class compulsory just because it has a room or appears in the timetable. " +
            "A class is only mandatory if the COURSE NOTES (from the Learn page/announcements) explicitly say attendance is required/compulsory/mandatory. " +
            "When asked what's compulsory or what must be attended in person, rely on COURSE NOTES; if nothing there requires attendance, say lectures/classes are generally optional (recorded on Echo360) and point them to the course page to confirm. " +
            "If the data doesn't contain the answer, say so and suggest a Sync.\n\n" +
            `DATA:\n${context}`,
          model: MODEL_FAST,
          maxTokens: 700,
          temperature: 0.2,
        },
      );
      return { answer };
    },
  );
}

/** Compact, structured snapshot of the student's data for quick Q&A. */
function buildContext(): string {
  const db = getDb();
  const out: string[] = [];

  const courses = db
    .prepare("SELECT id, code, name FROM courses WHERE active = 1 ORDER BY code")
    .all() as { id: string; code: string | null; name: string }[];
  const codeOf = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "General";
  out.push("ACTIVE COURSES:");
  for (const c of courses) out.push(`- ${c.code}: ${c.name}`);

  // Class schedule → dedupe 100s of sessions into components.
  const classes = db
    .prepare(
      "SELECT course_id, title, location, notes, start_at, end_at FROM events WHERE kind = 'class'",
    )
    .all() as { course_id: string | null; title: string; location: string | null; notes: string | null; start_at: string; end_at: string | null }[];
  const comps = new Map<
    string,
    { course: string; title: string; location: string | null; slots: Set<string> }
  >();
  for (const e of classes) {
    const key = `${e.course_id}|${e.title}|${e.location}`;
    const c = comps.get(key) ?? {
      course: codeOf(e.course_id),
      title: e.title,
      location: e.location,
      slots: new Set<string>(),
    };
    const d = new Date(e.start_at);
    const time = `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    c.slots.add(time);
    comps.set(key, c);
  }
  out.push("\nCLASS SCHEDULE (timetabled sessions; a room means it's held on campus, but attendance may still be optional):");
  if (comps.size === 0) out.push("- (no timetable imported yet)");
  for (const c of comps.values()) {
    const slots = [...c.slots].slice(0, 5).join(", ");
    out.push(`- ${c.course} · ${c.title} · ${slots}${c.location ? ` · ${c.location}` : " · (no room / likely online)"}`);
  }

  // Course notes that mention attendance/logistics — the real source of truth.
  const kw = ["attend", "compulsor", "mandator", "in person", "in-person", "required", "expected to", "participation", "must be"];
  const like = kw.map(() => "lower(body) LIKE ?").join(" OR ");
  const notes = db
    .prepare(`SELECT course_id, title, body FROM course_text WHERE ${like} LIMIT 30`)
    .all(...kw.map((k) => `%${k}%`)) as { course_id: string | null; title: string | null; body: string }[];
  if (notes.length) {
    out.push("\nCOURSE NOTES mentioning attendance/logistics (authoritative for what's required):");
    for (const n of notes.slice(0, 12)) {
      out.push(`- ${codeOf(n.course_id)}${n.title ? ` (${n.title})` : ""}: ${n.body.slice(0, 260)}`);
    }
  }

  const assignments = db
    .prepare(
      `SELECT a.title, a.due_at, a.open_at, c.code FROM assignments a JOIN courses c ON c.id = a.course_id
       WHERE c.active = 1 ORDER BY a.due_at IS NULL, a.due_at`,
    )
    .all() as { title: string; due_at: string | null; open_at: string | null; code: string | null }[];
  out.push("\nASSIGNMENTS:");
  if (!assignments.length) out.push("- (none)");
  for (const a of assignments)
    out.push(`- ${a.code}: ${a.title}${a.due_at ? ` · due ${new Date(a.due_at).toLocaleString()}` : ""}`);

  // Lecture transcript availability per course.
  const lects = db
    .prepare(
      `SELECT c.code, t.status FROM lectures l JOIN courses c ON c.id = l.course_id
       LEFT JOIN transcripts t ON t.lecture_id = l.id WHERE c.active = 1`,
    )
    .all() as { code: string | null; status: string | null }[];
  if (lects.length) {
    const byCourse = new Map<string, { total: number; done: number }>();
    for (const l of lects) {
      const k = l.code ?? "?";
      const v = byCourse.get(k) ?? { total: 0, done: 0 };
      v.total++;
      if (l.status === "done") v.done++;
      byCourse.set(k, v);
    }
    out.push("\nLECTURE MATERIALS (transcribed / total):");
    for (const [code, v] of byCourse) out.push(`- ${code}: ${v.done}/${v.total}`);
  }

  return out.join("\n");
}
