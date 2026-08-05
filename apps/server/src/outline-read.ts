import { getDb } from "@uni/db";
import { complete, hasApiKey, MODEL_DRAFT } from "@uni/ai";

/**
 * Read the course outline the app already downloaded.
 *
 * Every university publishes the assessment schedule — what each piece is worth,
 * when it's due, what you must clear to pass — in a PDF handed out in week one.
 * The app downloads that PDF and extracts its text, and then asks the student to
 * type the weightings in by hand. Three of four courses here have no weightings
 * at all, which means the grade calculator can say nothing about them, the
 * workload model is guessing, and nothing knows when the exam is.
 *
 * The existing parser is line-based, which suits a table pasted out of a browser
 * and cannot survive a PDF: extraction flattens the whole assessment table onto
 * one line ("Assessment Date Weight Homework 5pm Friday, weekly 10% Test TBA 40%
 * Examination TBA 50%"). So this reads it with the model instead — and returns a
 * proposal for the student to confirm, because a wrong weighting silently
 * miscalculates every grade prediction afterwards.
 */

export interface OutlineItem {
  title: string;
  /** Percent of the final grade, 0–100. */
  weight: number | null;
  dueAt: string | null;
  /** Verbatim from the outline when there's no parseable date ("TBA", "week 6"). */
  dueText: string | null;
  isFinal: boolean;
  isBonus: boolean;
  /** A mark you must reach on this item regardless of your total. */
  minPercent: number | null;
  /** "best ten of twelve, 1% each" — a bundle, not one assessment. */
  group: { count: number; dropLowest: number } | null;
  kind: "exam" | "test" | "assignment" | "quiz" | "lab" | "participation" | "other";
}

export interface OutlineRead {
  courseId: string;
  courseCode: string | null;
  /** The file it came from, so the student can check it. */
  sourceTitle: string;
  sourceId: string;
  items: OutlineItem[];
  /** Sums the non-bonus weights — should be 100, and it's worth saying if not. */
  total: number;
  /** Official contact/study hours, which beats our estimate of them. */
  workload: { activity: string; hours: number }[] | null;
  /** Anything about passing that isn't a per-item hurdle. */
  passRequirements: string | null;
  notes: string | null;
}

/* --- Finding the outline --------------------------------------------------- */

interface Candidate {
  id: string;
  title: string;
  text: string;
  score: number;
}

/**
 * Which downloaded file is the outline. Named "…Course Outline…" usually, but not
 * always — so content counts too, and a file that contains an assessment table
 * beats one that merely has the word in its name.
 */
export function findOutline(courseId: string): Candidate | null {
  const rows = getDb()
    .prepare(
      `SELECT id, title, text FROM materials
        WHERE course_id = ? AND text IS NOT NULL AND length(text) > 800
        ORDER BY length(text)`,
    )
    .all(courseId) as { id: string; title: string; text: string }[];

  const scored: Candidate[] = [];
  for (const row of rows) {
    const name = row.title.toLowerCase();
    const body = row.text.toLowerCase();
    let score = 0;
    if (/course.?outline|syllabus|course.?information|handbook/.test(name)) score += 40;
    if (/outline/.test(name)) score += 10;
    // The heading a table of weights sits under, in English or te reo.
    if (/aromatawai|assessment\s+(date\s+)?weight|assessment\s+schedule/.test(body)) score += 30;
    if (/%\s*(of\s+)?(the\s+)?(final\s+)?(grade|course|mark)/.test(body)) score += 10;
    if (/learning outcomes?/.test(body)) score += 8;
    if (/course co-?ordinator|lecturer in charge/.test(body)) score += 8;
    // Percentages clustered near the word "weight" is the real signal.
    const pcts = (row.text.match(/\d{1,3}\s?%/g) ?? []).length;
    if (pcts >= 3 && /weight/.test(body)) score += 20;
    // A 400k-character textbook is not the outline, whatever it mentions.
    if (row.text.length > 120_000) score -= 40;
    if (score >= 40) scored.push({ ...row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

/* --- Reading it ------------------------------------------------------------ */

const SYSTEM =
  "You extract assessment schedules from university course outlines. You are precise and you never invent a number. " +
  "If a weight or date is not stated, return null for it rather than guessing — a wrong weighting silently corrupts every " +
  "grade prediction the student then makes. Reply with JSON only.";

/** How much of the outline to send. Assessment tables are near the front. */
const MAX_CHARS = 24_000;

export async function readOutline(courseId: string): Promise<OutlineRead | null> {
  if (!hasApiKey()) throw new Error("OPENAI_API_KEY is not set.");
  const db = getDb();
  const course = db.prepare("SELECT id, code, name FROM courses WHERE id = ?").get(courseId) as
    | { id: string; code: string | null; name: string }
    | undefined;
  if (!course) throw new Error("Course not found.");

  const file = findOutline(courseId);
  if (!file) return null;

  const year = new Date().getFullYear();
  const raw = await complete(
    `Course: ${course.code ?? course.name}\nToday: ${new Date().toISOString().slice(0, 10)}\n\n` +
      `Extract the assessment schedule from this course outline.\n\n` +
      `Return JSON of exactly this shape:\n` +
      `{"items":[{"title":string,"weight":number|null,"dueAt":string|null,"dueText":string|null,` +
      `"isFinal":boolean,"isBonus":boolean,"minPercent":number|null,` +
      `"group":{"count":number,"dropLowest":number}|null,` +
      `"kind":"exam"|"test"|"assignment"|"quiz"|"lab"|"participation"|"other"}],` +
      `"workload":[{"activity":string,"hours":number}]|null,` +
      `"passRequirements":string|null,"notes":string|null}\n\n` +
      `Rules:\n` +
      `- "weight" is percent of the FINAL COURSE GRADE as a number 0-100 (10% → 10). null if not stated.\n` +
      `- "dueAt" is ISO 8601 (${year}-MM-DD, or with time if given) ONLY when an actual date is stated. ` +
      `"TBA", "weekly", "week 6" are not dates — put those verbatim in "dueText" and leave dueAt null.\n` +
      `- "isFinal" marks the single final exam, the one a student solves for. Not a test or a mid-term.\n` +
      `- "group": when several pieces share one weight ("best ten of twelve count 1% each", ` +
      `"weekly homework, best 10"), return ONE item for the bundle with the TOTAL weight, ` +
      `count = how many exist, dropLowest = how many are discarded. Otherwise null.\n` +
      `- "minPercent": a mark required on this item to pass regardless of the total ("must achieve 40% in the exam").\n` +
      `- "workload": the official hours breakdown if the outline states one, else null.\n` +
      `- Do not include readings, lectures, or non-assessed activities as items.\n\n` +
      `OUTLINE:\n${file.text.slice(0, MAX_CHARS)}`,
    {
      system: SYSTEM,
      model: MODEL_DRAFT,
      maxTokens: 2000,
      temperature: 0,
      json: true,
      // Worth paying for: read once per course, and a misread weighting corrupts
      // every grade prediction afterwards. Cached so a retry is free.
      tier: "quality",
      task: "read-outline",
      cache: true,
    },
  );

  return interpret(raw, { id: course.id, code: course.code }, { id: file.id, title: file.title });
}

/**
 * Turn the model's JSON into something the grade calculator can be trusted with.
 * Split out from the request so the coercion rules — which is where a bad weight
 * or a "TBA" masquerading as a date would get through — can be tested directly.
 */
export function interpret(
  raw: string,
  course: { id: string; code: string | null },
  file: { id: string; title: string },
): OutlineRead {
  const parsed = safeJson(raw);
  if (!parsed) throw new Error("Couldn't read a schedule out of that outline.");

  const items = (Array.isArray(parsed.items) ? (parsed.items as unknown[]) : [])
    .map((i) => normaliseItem(i))
    .filter((i): i is OutlineItem => i !== null);

  // Only one item can be the thing the calculator solves for.
  const finals = items.filter((i: OutlineItem) => i.isFinal);
  if (finals.length > 1) {
    const keep = finals.reduce((a: OutlineItem, b: OutlineItem) =>
      (b.weight ?? 0) > (a.weight ?? 0) ? b : a,
    );
    for (const f of finals) if (f !== keep) f.isFinal = false;
  }

  return {
    courseId: course.id,
    courseCode: course.code,
    sourceTitle: file.title,
    sourceId: file.id,
    items,
    total: round2(
      items
        .filter((i: OutlineItem) => !i.isBonus)
        .reduce((sum: number, i: OutlineItem) => sum + (i.weight ?? 0), 0),
    ),
    workload: normaliseWorkload(parsed.workload),
    passRequirements: str(parsed.passRequirements),
    notes: str(parsed.notes),
  };
}

function normaliseItem(raw: any): OutlineItem | null {
  const title = str(raw?.title);
  if (!title) return null;
  const weight = num(raw?.weight);
  const group =
    raw?.group && num(raw.group.count) ? {
      count: Math.max(1, Math.round(num(raw.group.count)!)),
      dropLowest: Math.max(0, Math.round(num(raw.group.dropLowest) ?? 0)),
    } : null;
  // A bundle that drops more than it keeps is a misread, not a rule.
  if (group && group.dropLowest >= group.count) group.dropLowest = 0;

  return {
    title: title.slice(0, 120),
    weight: weight != null && weight > 0 && weight <= 100 ? round2(weight) : null,
    dueAt: isoOrNull(raw?.dueAt),
    dueText: str(raw?.dueText),
    isFinal: Boolean(raw?.isFinal),
    isBonus: Boolean(raw?.isBonus),
    minPercent: (() => {
      const m = num(raw?.minPercent);
      return m != null && m > 0 && m <= 100 ? m : null;
    })(),
    group,
    kind: KINDS.includes(raw?.kind) ? raw.kind : "other",
  };
}

const KINDS = ["exam", "test", "assignment", "quiz", "lab", "participation", "other"];

function normaliseWorkload(raw: any): { activity: string; hours: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out = (raw as unknown[])
    .map((r: any) => ({ activity: str(r?.activity) ?? "", hours: num(r?.hours) ?? 0 }))
    .filter((r: { activity: string; hours: number }) => r.activity && r.hours > 0 && r.hours < 1000);
  return out.length ? out : null;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Models occasionally wrap JSON in a fence despite being told not to.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.toLowerCase() !== "null" ? s : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** Accept a date only if it really is one — "TBA" must not become 1 January. */
function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? s : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
