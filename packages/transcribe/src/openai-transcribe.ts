import { readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { TranscriptSegment } from "@uni/db";
import { getSetting } from "@uni/db";
import { recordAiUsage } from "@uni/ai";
import { splitAudio, probeDuration } from "./ffmpeg.js";
import { localTranscriber, transcribeLocally } from "./local-transcribe.js";

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
  // Prefer the machine. Lecture audio is the biggest line on the bill and the
  // one job a laptop can do for free, so paying per minute is a fallback rather
  // than the default.
  if (getSetting("transcribe_provider") !== "openai") {
    const local = await localTranscriber();
    if (local) {
      const started = Date.now();
      const r = await transcribeLocally(audioPath, local);
      recordAiUsage({
        provider: "local-whisper",
        model: local.model ? basename(local.model) : local.engine,
        task: "transcribe",
        inChars: 0,
        outChars: r.text.length,
        usd: 0,
      });
      void started;
      if (r.text.trim().length > 0) return r;
      // An empty local result is worse than none — fall through and pay rather
      // than storing a blank transcript for an hour of audio.
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "No way to transcribe: no local Whisper installed and no OPENAI_API_KEY. Install whisper.cpp (brew install whisper-cpp) to do it on this machine for free.",
    );
  }

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

  // $0.006/min is the published whisper-1 rate; logged so the audio half of the
  // bill shows up next to the text half instead of being invisible.
  const minutes = ((json.duration as number) ?? 0) / 60;
  recordAiUsage({
    provider: "openai-whisper",
    model: MODEL(),
    task: "transcribe",
    inChars: 0,
    outChars: String(json.text ?? "").length,
    usd: minutes * 0.006,
  });

  const segments: TranscriptSegment[] = (json.segments ?? []).map((s: any) => ({
    start: (s.start ?? 0) + offsetSec,
    end: (s.end ?? 0) + offsetSec,
    text: (s.text ?? "").trim(),
  }));
  return { text: (json.text ?? "").trim(), segments };
}
