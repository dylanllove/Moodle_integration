import { readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { TranscriptSegment } from "@uni/db";
import { splitAudio, probeDuration } from "./ffmpeg.js";

const MODEL = () => process.env.AI_TRANSCRIBE_MODEL || "whisper-1";
const MAX_BYTES = 24 * 1024 * 1024; // OpenAI limit is 25MB; leave headroom.
const CHUNK_SECONDS = 20 * 60;

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
}

/**
 * Transcribe an audio file with OpenAI. Files over the size limit are split
 * into time chunks, transcribed separately, and stitched with corrected
 * timestamps.
 */
export async function transcribeFile(audioPath: string): Promise<TranscriptResult> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");

  if (statSync(audioPath).size <= MAX_BYTES) {
    return transcribeOne(audioPath, 0);
  }

  // Too big — split into chunks and offset each chunk's timestamps.
  const dir = mkdtempSync(join(tmpdir(), "uni-tr-"));
  const chunks = await splitAudio(audioPath, CHUNK_SECONDS, dir, basename(audioPath, ".mp3"));
  const merged: TranscriptResult = { text: "", segments: [] };
  let offset = 0;
  for (const chunk of chunks) {
    const part = await transcribeOne(chunk, offset);
    merged.text += (merged.text ? "\n" : "") + part.text;
    merged.segments.push(...part.segments);
    offset += (await probeDuration(chunk)) ?? CHUNK_SECONDS;
  }
  return merged;
}

async function transcribeOne(path: string, offsetSec: number): Promise<TranscriptResult> {
  const buf = readFileSync(path);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), basename(path));
  form.append("model", MODEL());
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`OpenAI transcription: ${json.error.message}`);

  const segments: TranscriptSegment[] = (json.segments ?? []).map((s: any) => ({
    start: (s.start ?? 0) + offsetSec,
    end: (s.end ?? 0) + offsetSec,
    text: (s.text ?? "").trim(),
  }));
  return { text: (json.text ?? "").trim(), segments };
}
