import type { FastifyInstance } from "fastify";
import { getDb } from "@uni/db";
import { complete, completeStream, hasApiKey, localStatus, retrieve } from "@uni/ai";
import { describeSource, type SourceRef } from "../sources.js";

interface AskBody {
  question: string;
  history?: { role: string; content: string }[];
}

/**
 * Everything a single answer needs: the prompt, and the material it was built
 * from. The sources travel with the answer so the student can open the lecture
 * or slide it came from — an ungrounded claim about your own course is worse
 * than no answer, and the only cure is showing the receipt.
 */
function buildAsk(body: AskBody): { prompt: string; system: string; sources: SourceRef[] } {
  const question = body.question.trim();
  const context = buildContext();
  const chunks = retrieve(question, null, 6);
  const contentBlock = chunks.length
    ? chunks
        .map((c, i) => {
          const ref = describeSource(c.sourceType, c.sourceId);
          const label = ref ? `${ref.courseCode ? `${ref.courseCode} · ` : ""}${ref.label}` : "course material";
          return `[${i + 1}] (${label})\n${c.text}`;
        })
        .join("\n\n")
    : "(no matching lecture/course content indexed yet)";

  const seen = new Set<string>();
  const sources: SourceRef[] = [];
  for (const c of chunks) {
    const ref = describeSource(c.sourceType, c.sourceId);
    if (!ref) continue;
    const key = ref.to ?? ref.href ?? ref.label;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(ref);
  }

  const history = (body.history ?? [])
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Q" : "A"}: ${m.content}`)
    .join("\n");

  return {
    prompt: `${history ? `Earlier in this chat:\n${history}\n\n` : ""}Question: ${question}`,
    system:
      "You are the student's study assistant and tutor, with access to their own university data below. " +
      "Answer from this data. For **logistics** questions (deadlines, timetable, what's due, where/when a class is) be brief and direct. " +
      "For **content/learning** questions (explain X, quiz me, what did the lecturer say about Y), teach clearly using COURSE CONTENT — explain in plain language, give examples, and offer to quiz them. " +
      "Surface lecturer exam hints when relevant. Ground answers in the material; if it isn't there, say so and suggest a Sync.\n" +
      "ATTENDANCE: lectures are recorded on Echo360 and generally OPTIONAL — never call a class compulsory just because it's timetabled or has a room; only if COURSE NOTES explicitly require attendance.\n\n" +
      `=== STRUCTURE (courses, schedule, assignments) ===\n${context}\n\n` +
      `=== COURSE CONTENT (relevant excerpts from lectures/slides/notes/announcements) ===\n${contentBlock}`,
    sources,
  };
}

export async function registerAskRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AskBody }>("/api/ai/ask", async (req, reply) => {
    // A local model is a complete substitute for a key here.
    if (!hasApiKey() && !(await localStatus()).ok) {
      return reply.code(400).send({
        error:
          "No model available: add an OpenAI key in setup, or install a local one to run this for free.",
      });
    }
    if (!(req.body.question ?? "").trim()) return reply.code(400).send({ error: "empty question" });

    const { prompt, system, sources } = buildAsk(req.body);
    const answer = await complete(prompt, {
      system,
      maxTokens: 900,
      temperature: 0.3,
      tier: "bulk",
      task: "chat",
    });
    return { answer, sources };
  });

  /**
   * The same answer, streamed. Retrieval over a semester of slides and
   * transcripts takes a moment and the model takes several more; watching the
   * answer arrive is the difference between "thinking" and "broken".
   */
  app.post<{ Body: AskBody }>("/api/ai/ask/stream", async (req, reply) => {
    if (!hasApiKey() && !(await localStatus()).ok) {
      return reply.code(400).send({
        error:
          "No model available: add an OpenAI key in setup, or install a local one to run this for free.",
      });
    }
    if (!(req.body.question ?? "").trim()) return reply.code(400).send({ error: "empty question" });

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);

    try {
      const { prompt, system, sources } = buildAsk(req.body);
      send({ type: "sources", sources });
      for await (const delta of completeStream(prompt, {
        system,
        maxTokens: 900,
        temperature: 0.3,
        tier: "bulk",
        task: "chat",
      })) {
        send({ type: "delta", text: delta });
      }
      send({ type: "done" });
    } catch (e) {
      send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      reply.raw.end();
    }
    return reply;
  });
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
