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
