import { createHash } from "node:crypto";
import type { TranscriptSegment } from "@uni/db";
import { completeWhere } from "./client.js";

/**
 * One lecture in, structured study material out — in a single model call.
 *
 * This replaces two calls that each read the whole lecture: one wrote a markdown
 * blob of notes, and a second read those notes back to invent flashcards. The
 * blob couldn't be queried, linked or searched by concept, and nothing in it said
 * *when* anything was said. Here the model returns data against a fixed schema,
 * and every item points at a numbered line of the transcript, which we map back
 * to a second of the recording ourselves — models copy an index far more
 * reliably than they do arithmetic on timestamps.
 */

/** Bump when the schema or prompt changes enough that old digests should be redone. */
export const ANALYSIS_VERSION = 1;

export type ConceptKind = "concept" | "term" | "formula";
export type Anchor = "seconds" | "page" | "none";

export interface LectureAnalysis {
  tldr: string;
  topics: string[];
  sections: { title: string; summary: string; start: number | null; end: number | null }[];
  concepts: {
    kind: ConceptKind;
    name: string;
    explanation: string;
    /** Index into `sections`, or -1. */
    section: number;
    start: number | null;
  }[];
  emphasis: { quote: string; why: string; start: number | null }[];
  questions: { q: string; a: string; concept: string; start: number | null }[];
}

export interface AnalysisResult {
  analysis: LectureAnalysis;
  inputHash: string;
  model: string;
  /**
   * What every `start` means: seconds into the recording, a slide/page number,
   * or nothing at all for text that came with no structure.
   */
  anchor: Anchor;
}

/** A numbered, time-stamped line of transcript as the model sees it. */
interface Line {
  start: number | null;
  end: number | null;
  page: number | null;
  text: string;
}

/** Roughly 30 seconds of speech per line: fine enough to point at, coarse enough to be cheap. */
const LINE_SECONDS = 30;
const LINE_CHARS = 420;
/** Past this, the lecture is analysed in windows instead of truncated. */
const WINDOW_CHARS = 60_000;

/**
 * Analyse a lecture. `segments` are used when present (timestamps, or pages for
 * a slide deck); otherwise the plain text is split into lines with no times.
 */
export async function analyseLecture(input: {
  text: string;
  segments?: TranscriptSegment[] | null;
  title?: string;
  courseName?: string;
}): Promise<AnalysisResult> {
  const lines = toLines(input.text, input.segments ?? null);
  const anchor: Anchor = lines.some((l) => l.start != null)
    ? "seconds"
    : lines.some((l) => l.page != null)
      ? "page"
      : "none";
  const timed = anchor === "seconds";
  const inputHash = createHash("sha256")
    .update(`${ANALYSIS_VERSION}\n${lines.map((l) => l.text).join("\n")}`)
    .digest("hex")
    .slice(0, 32);

  const windows = splitWindows(lines, WINDOW_CHARS);
  const parts: LectureAnalysis[] = [];
  let model = "";
  for (let w = 0; w < windows.length; w++) {
    const { analysis, model: m } = await analyseWindow(windows[w]!, lines, timed, {
      title: input.title,
      courseName: input.courseName,
      part: windows.length > 1 ? { n: w + 1, of: windows.length } : null,
    });
    parts.push(analysis);
    model = m;
  }

  const analysis = parts.length === 1 ? parts[0]! : await mergeParts(parts, input.title);
  return { analysis, inputHash, model, anchor };
}

/* --- Lines ------------------------------------------------------------------ */

function toLines(text: string, segments: TranscriptSegment[] | null): Line[] {
  const segs = (segments ?? []).filter((s) => s && typeof s.text === "string" && s.text.trim());
  if (segs.length) {
    // Slide decks: one line per page, however long, so a citation lands on a slide.
    if (segs.some((s) => s.page != null)) {
      return segs.map((s) => ({ start: null, end: null, page: s.page ?? null, text: squash(s.text) }));
    }
    const out: Line[] = [];
    let cur: Line | null = null;
    for (const s of segs) {
      const t = squash(s.text);
      if (!cur || s.start - (cur.start ?? 0) >= LINE_SECONDS || cur.text.length + t.length > LINE_CHARS) {
        if (cur) out.push(cur);
        cur = { start: s.start, end: s.end, page: null, text: t };
      } else {
        cur.text += " " + t;
        cur.end = s.end;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // No structure at all: sentence-ish lines of about the same size.
  const out: Line[] = [];
  let buf = "";
  for (const sentence of squash(text).split(/(?<=[.!?])\s+/)) {
    if (buf && buf.length + sentence.length > LINE_CHARS) {
      out.push({ start: null, end: null, page: null, text: buf });
      buf = "";
    }
    buf += (buf ? " " : "") + sentence;
  }
  if (buf) out.push({ start: null, end: null, page: null, text: buf });
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function splitWindows(lines: Line[], maxChars: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.text.length + 12;
    if (size + len > maxChars && i > from) {
      out.push({ from, to: i });
      from = i;
      size = 0;
    }
    size += len;
  }
  out.push({ from, to: lines.length });
  return out;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function label(i: number, l: Line): string {
  if (l.start != null) return `[${i}|${clock(l.start)}]`;
  if (l.page != null) return `[${i}|p${l.page}]`;
  return `[${i}]`;
}

/* --- The call ---------------------------------------------------------------- */

/** Line references as the model returns them, before they become seconds. */
interface RawAnalysis {
  tldr: string;
  topics: string[];
  sections: { title: string; summary: string; line: number }[];
  concepts: { kind: ConceptKind; name: string; explanation: string; section: number; line: number }[];
  emphasis: { quote: string; why: string; line: number }[];
  questions: { q: string; a: string; concept: string; line: number }[];
}

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

/** Strict-mode JSON Schema: every field required, nothing extra. */
const ANALYSIS_SCHEMA = obj({
  tldr: str,
  topics: { type: "array", items: str },
  sections: { type: "array", items: obj({ title: str, summary: str, line: int }) },
  concepts: {
    type: "array",
    items: obj({
      kind: { type: "string", enum: ["concept", "term", "formula"] },
      name: str,
      explanation: str,
      section: int,
      line: int,
    }),
  },
  emphasis: { type: "array", items: obj({ quote: str, why: str, line: int }) },
  questions: { type: "array", items: obj({ q: str, a: str, concept: str, line: int }) },
});

const SYSTEM =
  "You turn lecture transcripts and slide text into accurate, structured study material. You never add facts that are not in the material, and you output only JSON matching the schema.";

async function analyseWindow(
  win: { from: number; to: number },
  lines: Line[],
  timed: boolean,
  meta: { title?: string; courseName?: string; part: { n: number; of: number } | null },
): Promise<{ analysis: LectureAnalysis; model: string }> {
  const body = lines
    .slice(win.from, win.to)
    .map((l, k) => `${label(win.from + k, l)} ${l.text}`)
    .join("\n");
  const what = meta.title ? `"${meta.title}"` : "a lecture";
  const partNote = meta.part
    ? `\nThis is part ${meta.part.n} of ${meta.part.of} of the lecture; cover only this part.`
    : "";

  const prompt = `Below is ${what}${meta.courseName ? ` from ${meta.courseName}` : ""}, as numbered lines ${
    timed ? "[line|time]" : "[line]"
  }.${partNote}

Return:
- tldr: 2–3 sentences on what this lecture covers.
- topics: 3–8 short topic labels.
- sections: the lecture's natural parts in order, each with a title, a 1–3 sentence summary, and the line where it starts.
- concepts: the key ideas (kind "concept"), terminology with definitions ("term") and formulae or procedures ("formula"). A one-line plain-English explanation each, the index of its section (or -1), and the line where it is introduced.
- emphasis: anything the lecturer stressed, repeated, or flagged as important or examinable ("this will be on the exam", "make sure you know…"). A short quote, why it matters, and its line. Empty if none.
- questions: up to ${meta.part ? 12 : 20} flashcard questions with answers. ONE testable fact, definition, mechanism or distinction each. Questions must stand alone months later — never "according to the lecturer" or "in this lecture". Answers 1–2 sentences. Name the concept it tests and its line. Skip admin (due dates, rooms, staff). Fewer good questions beats padding.

Every "line" must be a line number shown below. Base everything ONLY on this material.

MATERIAL:
${body}`;

  const opts = {
    system: SYSTEM,
    maxTokens: 8000,
    temperature: 0.2,
    tier: "bulk" as const,
    task: "lecture-analysis",
    schema: { name: "lecture_analysis", schema: ANALYSIS_SCHEMA },
  };

  let res = await completeWhere(prompt, { ...opts, cache: true });
  let raw = parseRaw(res.text);
  if (!raw) {
    // Structured output makes this rare, but a truncated answer isn't valid JSON
    // either. The retry differs in temperature, so it has its own cache entry:
    // the bad first answer can't be served for it, and a good second answer is
    // kept — the next run reads both from the cache instead of paying again.
    res = await completeWhere(prompt, { ...opts, temperature: 0.35, cache: true });
    raw = parseRaw(res.text);
  }
  if (!raw) throw new Error("Lecture analysis returned unreadable JSON twice");
  return { analysis: resolveLines(raw, lines, win), model: res.model };
}

function parseRaw(text: string): RawAnalysis | null {
  try {
    const j = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim());
    if (!j || typeof j !== "object" || typeof j.tldr !== "string") return null;
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : -1);
    const kind = (v: unknown): ConceptKind => (v === "term" || v === "formula" ? v : "concept");
    return {
      tldr: s(j.tldr),
      topics: arr(j.topics).map(s).filter(Boolean),
      sections: arr(j.sections)
        .map((x: any) => ({ title: s(x?.title), summary: s(x?.summary), line: n(x?.line) }))
        .filter((x) => x.title),
      concepts: arr(j.concepts)
        .map((x: any) => ({
          kind: kind(x?.kind),
          name: s(x?.name),
          explanation: s(x?.explanation),
          section: n(x?.section),
          line: n(x?.line),
        }))
        .filter((x) => x.name && x.explanation),
      emphasis: arr(j.emphasis)
        .map((x: any) => ({ quote: s(x?.quote), why: s(x?.why), line: n(x?.line) }))
        .filter((x) => x.quote),
      questions: arr(j.questions)
        .map((x: any) => ({ q: s(x?.q), a: s(x?.a), concept: s(x?.concept), line: n(x?.line) }))
        .filter((x) => x.q && x.a),
    };
  } catch {
    return null;
  }
}

/** Line numbers → seconds, clamped to the window so a bad index can't point elsewhere. */
function resolveLines(raw: RawAnalysis, lines: Line[], win: { from: number; to: number }): LectureAnalysis {
  const at = (line: number): number | null => {
    const i = line < win.from || line >= win.to ? -1 : line;
    return i < 0 ? null : (lines[i]!.start ?? lines[i]!.page ?? null);
  };
  const sections = raw.sections
    .map((x) => ({ title: x.title, summary: x.summary, start: at(x.line), line: x.line }))
    .sort((a, b) => a.line - b.line);
  const windowEnd = lines[win.to - 1]?.end ?? null;
  return {
    tldr: raw.tldr,
    topics: raw.topics,
    sections: sections.map((x, i) => ({
      title: x.title,
      summary: x.summary,
      start: x.start,
      end: sections[i + 1]?.start ?? windowEnd,
    })),
    concepts: raw.concepts.map((x) => ({
      kind: x.kind,
      name: x.name,
      explanation: x.explanation,
      section: x.section >= 0 && x.section < sections.length ? x.section : -1,
      start: at(x.line),
    })),
    emphasis: raw.emphasis.map((x) => ({ quote: x.quote, why: x.why, start: at(x.line) })),
    questions: raw.questions.map((x) => ({ q: x.q, a: x.a, concept: x.concept, start: at(x.line) })),
  };
}

/* --- Long lectures ---------------------------------------------------------- */

const MERGE_SCHEMA = obj({ tldr: str, topics: { type: "array", items: str } });

/**
 * Stitch windowed analyses together. Sections, concepts, hints and questions are
 * already in lecture order and just concatenate; only the overview needs a model,
 * and a very small one-shot call at that.
 */
async function mergeParts(parts: LectureAnalysis[], title?: string): Promise<LectureAnalysis> {
  const sections: LectureAnalysis["sections"] = [];
  const concepts: LectureAnalysis["concepts"] = [];
  const seenConcept = new Set<string>();
  const seenQuestion = new Set<string>();
  const out: LectureAnalysis = { tldr: "", topics: [], sections, concepts, emphasis: [], questions: [] };

  for (const p of parts) {
    const offset = sections.length;
    sections.push(...p.sections);
    for (const c of p.concepts) {
      const key = c.name.toLowerCase();
      if (seenConcept.has(key)) continue;
      seenConcept.add(key);
      concepts.push({ ...c, section: c.section >= 0 ? c.section + offset : -1 });
    }
    out.emphasis.push(...p.emphasis);
    for (const q of p.questions) {
      const key = q.q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenQuestion.has(key)) continue;
      seenQuestion.add(key);
      out.questions.push(q);
    }
  }

  const overview = parts.map((p, i) => `Part ${i + 1}: ${p.tldr}\nTopics: ${p.topics.join(", ")}`).join("\n\n");
  try {
    const res = await completeWhere(
      `These are summaries of consecutive parts of one lecture${title ? ` ("${title}")` : ""}. Write a 2–3 sentence tldr of the whole lecture and 3–8 topic labels for it.\n\n${overview}`,
      {
        system: SYSTEM,
        maxTokens: 600,
        temperature: 0.2,
        tier: "bulk",
        task: "lecture-analysis",
        schema: { name: "lecture_overview", schema: MERGE_SCHEMA },
        cache: true,
      },
    );
    const j = JSON.parse(res.text) as { tldr?: string; topics?: string[] };
    out.tldr = (j.tldr ?? "").trim();
    out.topics = (j.topics ?? []).filter((t) => typeof t === "string" && t.trim());
  } catch {
    /* fall back to the parts' own words below */
  }
  if (!out.tldr) out.tldr = parts.map((p) => p.tldr).join(" ");
  if (!out.topics.length) out.topics = [...new Set(parts.flatMap((p) => p.topics))].slice(0, 8);
  return out;
}

/* --- Markdown, for everything that still reads the summary blob ------------- */

/**
 * The same study notes the app has always shown, rendered from the data instead
 * of written by the model — so exports, the course deck builder and the notes
 * tab keep working, and can never disagree with the structured rows.
 */
export function renderNotesMarkdown(a: LectureAnalysis, anchor: Anchor): string {
  const at = (start: number | null) =>
    start == null || anchor === "none"
      ? ""
      : anchor === "seconds"
        ? ` _(${clock(start)})_`
        : ` _(slide ${start})_`;
  const md: string[] = [];
  md.push("## TL;DR", a.tldr, "");

  const concepts = a.concepts.filter((c) => c.kind === "concept");
  md.push("## Key concepts");
  if (concepts.length) for (const c of concepts) md.push(`- **${c.name}** — ${c.explanation}${at(c.start)}`);
  else md.push("None identified.");
  md.push("");

  const terms = a.concepts.filter((c) => c.kind !== "concept");
  if (terms.length) {
    md.push("## Key terms");
    for (const c of terms) md.push(`- **${c.name}** — ${c.explanation}${at(c.start)}`);
    md.push("");
  }

  md.push("## ⭐ Likely exam / emphasis");
  if (a.emphasis.length) for (const e of a.emphasis) md.push(`- “${e.quote}” — ${e.why}${at(e.start)}`);
  else md.push("None flagged explicitly.");
  md.push("");

  if (a.questions.length) {
    md.push("## Test yourself");
    for (const q of a.questions.slice(0, 5)) md.push(`- ${q.q}`);
  }
  return md.join("\n").trim();
}
