import { getSetting } from "@uni/db";
import { complete, MODEL_FAST, MODEL_DRAFT } from "./client.js";

/** Cap very long transcripts so we stay within a sensible request size. */
function clamp(text: string, max = 48_000): string {
  return text.length > max ? text.slice(0, max) + "\n…[truncated]" : text;
}

/** Summarise a lecture transcript into clean study notes (markdown). */
export function summariseLecture(transcript: string, title?: string): Promise<string> {
  return complete(
    `Here is a lecture transcript${title ? ` titled "${title}"` : ""}. Write concise, well-structured study notes in markdown: a short overview, the key concepts as bullet points with brief explanations, any definitions or formulae, and 3–5 review questions at the end.\n\nTRANSCRIPT:\n${clamp(transcript)}`,
    {
      system:
        "You are a study assistant that turns lecture transcripts into clear, accurate notes. Never invent facts that aren't supported by the transcript.",
      maxTokens: 2048,
      tier: "bulk",
      task: "lecture-summary",
      cache: true,
    },
  );
}

/** Turn a transcript into structured, headed notes (markdown). */
export function transcriptToNotes(transcript: string): Promise<string> {
  return complete(
    `Reorganise this lecture transcript into structured markdown notes with headings and sub-bullets, preserving the lecturer's meaning. Remove filler and repetition. Do not add facts.\n\nTRANSCRIPT:\n${clamp(transcript)}`,
    { maxTokens: 3000, tier: "bulk", task: "transcript-notes", cache: true },
  );
}

/** Explain a highlighted passage more simply. */
export function explain(text: string, context?: string): Promise<string> {
  return complete(
    `Explain the following clearly and simply, as if to a student seeing it for the first time. Use an example if helpful.\n\n${context ? `CONTEXT:\n${clamp(context, 8000)}\n\n` : ""}PASSAGE:\n${clamp(text, 8000)}`,
    { tier: "bulk", task: "explain" },
  );
}

/**
 * Produce an exam-focused cheat sheet from aggregated course material (slides,
 * lecture transcripts, forum posts, assignment briefs). Surfaces the most
 * important / likely-to-be-tested content, including things the lecturer
 * emphasised or hinted at.
 */
export function cheatSheet(courseName: string, corpus: string): Promise<string> {
  return complete(
    `You are helping a university student prepare efficiently for "${courseName}". Below is aggregated course material: lecture slides, transcripts, forum posts/announcements, and assignment briefs.

Produce a concise, high-signal **exam cheat sheet in markdown** that shortcuts studying. Include:
- **Most important concepts** (definitions, key ideas) — the things this course clearly centres on.
- **Likely exam / assessment topics** — what the material and briefs suggest will be tested.
- **Lecturer emphasis & hints** — anything flagged as important, "will be on the test", frequently repeated, or stressed in forums/announcements. Quote the hint briefly.
- **Key formulae / frameworks / processes** if any.
- **Common pitfalls / things students get wrong**, if mentioned.
Group by topic. Be specific and grounded ONLY in the material — do not invent. Where a point comes from a hint/announcement, note it (e.g. "_(lecturer, forum)_").

MATERIAL:
${corpus}`,
    {
      system:
        "You are an exam-prep assistant that distils course material into a precise, trustworthy cheat sheet. Never fabricate facts or hints that aren't supported by the material.",
      // A cheat sheet is read before an exam and being wrong is expensive, so
      // this is one of the two jobs still worth paying a frontier model for.
      model: MODEL_DRAFT,
      maxTokens: 3500,
      tier: "quality",
      task: "cheatsheet",
      cache: true,
    },
  );
}

/**
 * Turn a raw ASR transcript (run-on, no punctuation, filler words) into clean,
 * readable prose — fixing punctuation/capitalisation and splitting into
 * paragraphs, WITHOUT summarising or changing what was said. Chunked so long
 * lectures stay within limits.
 */
export async function cleanTranscript(raw: string): Promise<string> {
  const text = (raw ?? "").trim();
  if (text.length < 200) return text;

  // Off unless asked for. This rewrites the transcript in full, so you pay for
  // every word twice — once going in and once coming back, and output is the
  // dearer half. What it buys is a nicer read; search, the assistant, the notes
  // and the flashcards are all perfectly happy with raw ASR text. It was quietly
  // the largest text line on the bill for the smallest return.
  if (getSetting("clean_transcripts") !== "true") return text;

  const chunks = splitWords(text, 4500);
  const cleaned: string[] = [];
  for (const chunk of chunks) {
    cleaned.push(
      await complete(
        `Reformat this lecture transcript segment into clean, readable text. Fix punctuation and capitalisation, split into sensible paragraphs, and remove filler ("um", "uh", "you know"), false starts and stutters. Do NOT summarise, add, or remove real content — keep everything the speaker actually said. Output only the cleaned text.\n\nTRANSCRIPT:\n${chunk}`,
        {
          system: "You clean up speech-to-text transcripts. You never summarise or invent content.",
          maxTokens: 4096,
          temperature: 0.1,
          tier: "bulk",
          task: "clean-transcript",
          cache: true,
        },
      ),
    );
  }
  return cleaned.join("\n\n");
}

function splitWords(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return [text];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords).join(" "));
  return out;
}

/**
 * Turn one lecture (transcript or slide text) into tight, study-ready notes so a
 * student can learn the lecture in a few minutes instead of re-reading it all.
 */
export function lectureNotes(content: string, title?: string): Promise<string> {
  return complete(
    `Below is the content of a single lecture${title ? ` ("${title}")` : ""} — a transcript or slide text. Produce concise STUDY NOTES in markdown that let me learn this lecture in ~5 minutes:

## TL;DR
2–3 sentences on what this lecture was about.

## Key concepts
Each as a bullet: the concept in **bold**, then a one-line plain-English explanation.

## Key terms
Any definitions/terminology worth knowing (skip if none).

## ⭐ Likely exam / emphasis
Anything the lecturer stressed, repeated, or flagged as important or testable (e.g. "this will be on the exam", "make sure you know…"). Quote the hint briefly. If none are evident, say "None flagged explicitly."

## Test yourself
3–5 short questions (no answers) covering the most important points.

Base everything ONLY on the material below — do not invent. Be tight and skimmable.\n\nLECTURE CONTENT:\n${clamp(content, 90_000)}`,
    {
      system: "You produce accurate, concise lecture study notes. You never add facts not present in the material.",
      maxTokens: 1800,
      tier: "bulk",
      task: "flashcards",
      cache: true,
    },
  );
}

export interface Flashcard {
  q: string;
  a: string;
}

/** Generate flashcards from notes/transcript. Returns parsed Q/A pairs. */
export async function flashcards(text: string): Promise<Flashcard[]> {
  const raw = await complete(
    `Create study flashcards from this material. Respond with ONLY a JSON array of objects like {"q":"question","a":"answer"} — no prose, no markdown fences.\n\nMATERIAL:\n${clamp(text)}`,
    {
      system: "You output strictly valid JSON and nothing else.",
      maxTokens: 2048,
      json: true,
      tier: "bulk",
      task: "flashcards",
      cache: true,
    },
  );
  return parseJsonArray(raw);
}

export interface DeckOpts {
  /** What the material is, so questions can name the right topic. */
  title?: string;
  courseName?: string;
  /** Target card count. The model is told to stop early rather than pad. */
  count?: number;
}

/**
 * Deck-quality flashcards for spaced repetition — the difference from
 * `flashcards()` is the constraints: one fact per card, answers short enough to
 * recall out loud, no "what did the lecturer say about…" trivia, and no padding
 * to hit a number. Bad cards are worse than no cards; you drill them for weeks.
 */
export async function generateDeck(text: string, opts: DeckOpts = {}): Promise<Flashcard[]> {
  const count = Math.min(60, Math.max(5, opts.count ?? 20));
  const raw = await complete(
    `Write up to ${count} spaced-repetition flashcards from the material below${
      opts.title ? ` (from "${opts.title}"` : ""
    }${opts.courseName ? `${opts.title ? ", " : " ("}course: ${opts.courseName}` : ""}${
      opts.title || opts.courseName ? ")" : ""
    }.

Rules:
- ONE testable fact, definition, mechanism or distinction per card.
- Questions must stand alone — never "what did the slide say", "according to the lecturer", or "in this lecture". A card must make sense months later with no context.
- Answers: 1–2 sentences, or a short list. Short enough to say out loud from memory.
- Prefer what an exam would actually ask: definitions, why/how, comparisons, worked steps, formulae, common mistakes.
- Skip admin (due dates, room numbers, staff names), and skip anything the material doesn't actually explain.
- Fewer good cards beats padding to the limit. Stop when the real content runs out.

Respond with ONLY a JSON array of {"q":"…","a":"…"} — no prose, no markdown fences.

MATERIAL:
${clamp(text, 60_000)}`,
    {
      system:
        "You are an expert at writing flashcards for active recall. You output strictly valid JSON and nothing else, and you never invent facts absent from the material.",
      maxTokens: 4000,
      tier: "bulk",
      task: "deck-generate",
      cache: true,
      temperature: 0.2,
    },
  );
  return dedupe(parseJsonArray(raw));
}

/** Same question asked twice is a card you'll resent in week three. */
function dedupe(cards: Flashcard[]): Flashcard[] {
  const seen = new Set<string>();
  const out: Flashcard[] = [];
  for (const c of cards) {
    const q = c.q.trim();
    const a = c.a.trim();
    if (!q || !a) continue;
    const key = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ q, a });
  }
  return out;
}

function parseJsonArray(raw: string): Flashcard[] {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      return arr
        .filter((x) => x && typeof x.q === "string" && typeof x.a === "string")
        .map((x) => ({ q: x.q, a: x.a }));
    }
  } catch {
    // fall through
  }
  return [];
}
