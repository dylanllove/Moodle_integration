/**
 * Parse an assessment schedule pasted out of a course outline.
 *
 * Typing weights one cell at a time is the reason the grade calculator sits
 * empty, and every course hands you the numbers in a table already. This reads
 * the shapes those tables actually take:
 *
 *   Assignment 1 — 15%          Test 1 \t 20%
 *   Labs (best 8 of 10)  20%    Weekly quizzes x12: 10%
 *   Final Examination: 50%      3. Group project ......... 25
 *
 * Deliberately regex, not an AI call: it's instant, free, offline, and the user
 * sees a preview and fixes anything wrong before it's saved.
 */

export interface ParsedItem {
  title: string;
  weight: number;
  /** Flagged as the thing to solve for. */
  isFinal: boolean;
  /** Set when the line describes a bundle: "best 8 of 10 labs". */
  group?: { count: number; dropLowest: number };
  /** Set when the line reads as extra credit. */
  isBonus: boolean;
  /** A stated hurdle, e.g. "must achieve 40% in the final examination". */
  minPercent: number | null;
}

export interface ParseResult {
  items: ParsedItem[];
  total: number;
  /** Lines that looked like assessments but had no usable weight. */
  skipped: string[];
}

/** Lines that are headers, totals or prose rather than an assessment row. */
const NOISE =
  /^(total|overall|sum|assessment|weighting|component|item|due date|%|percentage|mark|grade|table|note|please)\b/i;

const FINAL = /\b(final|end[- ]of[- ](?:term|year|course)|closed[- ]book exam)\b/i;
const EXAM = /\bexam(?:ination)?\b/i;
const PRACTICE = /\b(practice|mock|past|sample|formative)\b/i;
const BONUS = /\b(bonus|extra credit|additional credit)\b/i;

export function parseOutline(text: string): ParseResult {
  const items: ParsedItem[] = [];
  const skipped: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/ /g, " ").trim();
    if (!line || line.length > 200) continue;

    const weight = extractWeight(line);
    const title = cleanTitle(stripWeight(line));
    if (!title || title.length > 90) {
      if (weight != null && title) skipped.push(line);
      continue;
    }
    if (NOISE.test(title)) continue;
    if (weight == null || weight <= 0 || weight > 100) {
      // Looks like a row, just no number we trust — surface it rather than
      // silently dropping something the student will expect to see.
      if (/\b(assignment|test|quiz|lab|exam|essay|report|project|tutorial|participation)\b/i.test(title)) {
        skipped.push(line);
      }
      continue;
    }

    items.push({
      title,
      weight,
      isFinal: (FINAL.test(title) || EXAM.test(title)) && !PRACTICE.test(title),
      group: extractGroup(line),
      isBonus: BONUS.test(line),
      minPercent: extractHurdle(line),
    });
  }

  // Only one item can be the solve-for target; keep the heaviest exam-ish one.
  const finals = items.filter((i) => i.isFinal);
  if (finals.length > 1) {
    const keep = finals.reduce((a, b) => (b.weight > a.weight ? b : a));
    for (const f of finals) if (f !== keep) f.isFinal = false;
  }

  return {
    items,
    total: round2(items.filter((i) => !i.isBonus).reduce((s, i) => s + i.weight, 0)),
    skipped,
  };
}

/**
 * The weight is the last percentage on the line, or a trailing bare number.
 * "Assignment 2 (worth 15% of 100)" → 15, taking the first %-of-grade reading
 * rather than the 100.
 */
function extractWeight(line: string): number | null {
  const percents = [...line.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s*%/g)].map((m) =>
    Number(m[1]!.replace(",", ".")),
  );
  const usable = percents.filter((n) => n > 0 && n <= 100);
  if (usable.length) {
    // "40% hurdle" mentions shouldn't win over the actual weighting: prefer the
    // last plausible weight, since outlines put the weight column on the right.
    const nonHurdle = usable.filter((n) => !isHurdleMention(line, n));
    return (nonHurdle.length ? nonHurdle : usable).at(-1) ?? null;
  }
  // No % sign: accept a number at the very end, after a separator or dots.
  const trailing = line.match(/(?:[\t:—–-]|\.{2,}|\s{2,})\s*(\d{1,3}(?:[.,]\d+)?)\s*$/);
  return trailing ? Number(trailing[1]!.replace(",", ".")) : null;
}

function isHurdleMention(line: string, value: number): boolean {
  const re = new RegExp(
    `(?:at least|minimum|min\\.?|must (?:achieve|obtain|pass|get)|hurdle)[^%\\d]{0,20}${value}\\s*%`,
    "i",
  );
  return re.test(line);
}

/**
 * A stated minimum on this item. The slop between phrase and number is
 * punctuation-only and short: a greedy `\D*` here happily reads "Final
 * Examination: 35%" as a 35% hurdle, because "Examination" contains "min".
 */
const HURDLE =
  /\b(?:at least|minimum(?:\s+of)?|min\.|must\s+(?:achieve|obtain|score|get|pass\s+with)|hurdle(?:\s+of)?|requires?)\b[^a-z0-9]{0,8}(\d{1,3})\s*%/i;

function extractHurdle(line: string): number | null {
  const m = line.match(HURDLE);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

function stripWeight(line: string): string {
  return line
    .replace(/\(?\s*(?:worth|weighting|weight)?\s*\d{1,3}(?:[.,]\d+)?\s*%\s*(?:of\s*(?:the\s*)?(?:final|total|overall)?\s*(?:grade|mark)?)?\s*\)?/gi, " ")
    .replace(/(?:[\t:—–-]|\.{2,}|\s{2,})\s*\d{1,3}(?:[.,]\d+)?\s*$/, " ");
}

/** "best 8 of 10", "top 4 of 5", "10 labs, lowest dropped", "x12". */
function extractGroup(line: string): ParsedItem["group"] | undefined {
  const bestOf = line.match(/\b(?:best|top|highest)\s*(\d{1,2})\s*(?:of|out of|from)\s*(\d{1,2})\b/i);
  if (bestOf) {
    const keep = Number(bestOf[1]);
    const count = Number(bestOf[2]);
    if (count > 1 && keep > 0 && keep <= count) {
      return { count, dropLowest: count - keep };
    }
  }

  const countMatch =
    line.match(/\b(?:x|×)\s*(\d{1,2})\b/i) ??
    line.match(/\b(\d{1,2})\s*(?:×|x)\b/i) ??
    line.match(/\b(\d{1,2})\s+(?:weekly\s+)?(?:labs?|quizzes|quizes|tests?|tutorials?|assignments?|worksheets?)\b/i);
  if (countMatch) {
    const count = Number(countMatch[1]);
    if (count > 1 && count <= 40) {
      return { count, dropLowest: Math.min(extractDropCount(line), count - 1) };
    }
  }
  return undefined;
}

/**
 * How many results get discarded. Outlines write it in either order — "drop the
 * lowest 2" and "lowest 2 dropped" — and the number must not be allowed to run
 * off and grab the weight at the end of the line ("lowest 2 dropped … 15%").
 */
function extractDropCount(line: string): number {
  if (!/\b(?:drop|discard|exclud|ignor|disregard)/i.test(line)) return 0;
  const patterns = [
    // "drop the lowest 2", "discarding your worst 3", "drops 2"
    /\b(?:drop|discard|exclud\w*|ignor\w*|disregard)\w*\s+(?:the\s+|your\s+)?(?:lowest|worst|poorest)?\s*(\d{1,2})\b(?!\s*%)/i,
    // "lowest 2 dropped", "worst 3 are excluded"
    /\b(?:lowest|worst|poorest)\s+(\d{1,2})\b(?!\s*%)/i,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n <= 40) return n;
    }
  }
  // "lowest dropped" with no number means one.
  return /\b(?:lowest|worst|poorest)\b/i.test(line) ? 1 : 0;
}

/**
 * Reduce a line to the assessment's name. Bullets, table pipes and numbering go;
 * so do the parentheticals and trailing clauses that described the *rules*
 * ("(best 8 of 10)", ", lowest 2 dropped") — those have already been read into
 * the group and hurdle, and leaving them makes for absurd row labels. A
 * parenthetical with no rules in it, like "(Part A)", is kept.
 */
const RULE_WORDS =
  /\d|\b(?:best|top|highest|lowest|worst|drop|discard|exclud|ignor|at least|minimum|min\.|must|hurdle|weight|worth)\b/i;

function cleanTitle(s: string): string {
  let out = s
    .replace(/^[\s|•·*–—-]+/, "")
    .replace(/^\(?\d{1,2}[.)]\s+/, "")
    .replace(/\|/g, " ");

  // Balanced parentheticals that only restate rules.
  out = out.replace(/\s*\(([^)]*)\)/g, (m, inner: string) => (RULE_WORDS.test(inner) ? " " : m));
  // An unterminated one, left behind after the weight was stripped out of it.
  out = out.replace(/\s*\([^)]*$/, " ");
  // A trailing clause after a comma that only describes the rules.
  out = out.replace(/,\s*([^,]*)$/, (m, tail: string) => (RULE_WORDS.test(tail) ? "" : m));

  return out
    // A trailing multiplier ("Laboratory work x10") is a count, not a name.
    .replace(/\s*[x×]\s*\d{1,2}\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s:.,–—-]+$/, "")
    .trim();
}

const round2 = (n: number) => Math.round(n * 100) / 100;
