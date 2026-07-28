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
    },
  );
}

/** Turn a transcript into structured, headed notes (markdown). */
export function transcriptToNotes(transcript: string): Promise<string> {
  return complete(
    `Reorganise this lecture transcript into structured markdown notes with headings and sub-bullets, preserving the lecturer's meaning. Remove filler and repetition. Do not add facts.\n\nTRANSCRIPT:\n${clamp(transcript)}`,
    { maxTokens: 3000 },
  );
}

/** Explain a highlighted passage more simply. */
export function explain(text: string, context?: string): Promise<string> {
  return complete(
    `Explain the following clearly and simply, as if to a student seeing it for the first time. Use an example if helpful.\n\n${context ? `CONTEXT:\n${clamp(context, 8000)}\n\n` : ""}PASSAGE:\n${clamp(text, 8000)}`,
    { model: MODEL_FAST },
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
      model: MODEL_DRAFT,
      maxTokens: 3500,
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

  const chunks = splitWords(text, 4500);
  const cleaned: string[] = [];
  for (const chunk of chunks) {
    cleaned.push(
      await complete(
        `Reformat this lecture transcript segment into clean, readable text. Fix punctuation and capitalisation, split into sensible paragraphs, and remove filler ("um", "uh", "you know"), false starts and stutters. Do NOT summarise, add, or remove real content — keep everything the speaker actually said. Output only the cleaned text.\n\nTRANSCRIPT:\n${chunk}`,
        {
          system: "You clean up speech-to-text transcripts. You never summarise or invent content.",
          model: MODEL_FAST,
          maxTokens: 4096,
          temperature: 0.1,
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
      model: MODEL_FAST,
      maxTokens: 1800,
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
    },
  );
  return parseJsonArray(raw);
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
