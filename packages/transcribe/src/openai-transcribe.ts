import { readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { TranscriptSegment } from "@uni/db";
import { getSetting } from "@uni/db";
import { estimateAudioCost, recordAiUsage, remainingBudgetUsd } from "@uni/ai";
import { splitAudio, probeDuration, speechSpans, toOriginalTime, writeSpeechOnly, type SpeechMap } from "./ffmpeg.js";
import { localTranscriber, transcribeLocally } from "./local-transcribe.js";

// whisper-1 stays the default because it's the one OpenAI transcription model
// that returns segment timestamps (verbose_json); without them nothing downstream
// can point at a moment in the lecture.
const MODEL = () => process.env.AI_TRANSCRIBE_MODEL || "whisper-1";
const MAX_BYTES = 24 * 1024 * 1024; // OpenAI limit is 25MB; leave headroom.
const CHUNK_SECONDS = 20 * 60;
/** Less talking than this (in a long recording) is a room, not a lecture. */
const MIN_SPEECH_SEC = 3 * 60;

export type TranscriptProvider = "auto" | "local" | "openai";

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
  source: "local-whisper" | "openai-whisper";
  model: string;
  /** Seconds of speech actually transcribed, when known. */
  speechSec: number | null;
}

/**
 * Why a recording wasn't transcribed, when that's a decision rather than a fault.
 * The caller records `reason` as the transcript's status and tries again later.
 */
export class TranscriptionDeferred extends Error {
  constructor(
    public reason: "needs_local" | "over_budget" | "no_recording",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionDeferred";
  }
}

export function transcribeProvider(): TranscriptProvider {
  const raw = getSetting("transcribe_provider");
  return raw === "local" || raw === "openai" ? raw : "auto";
}

/** Could a recording be transcribed right now, by any route the settings allow? */
export async function canTranscribe(): Promise<boolean> {
  const pref = transcribeProvider();
  if (pref !== "openai" && (await localTranscriber())) return true;
  return pref !== "local" && Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Transcribe an audio file: on this machine when possible, otherwise through
 * OpenAI — and then only the parts where someone is speaking, and only within
 * the monthly budget.
 *
 * The setting means what it says. "local" never sends audio away: with no local
 * model the lecture waits, marked `needs_local`, instead of quietly billing.
 */
export async function transcribeFile(audioPath: string): Promise<TranscriptResult> {
  const pref = transcribeProvider();

  if (pref !== "openai") {
    const local = await localTranscriber();
    if (local) {
      const r = await transcribeLocally(audioPath, local);
      const model = local.model ? basename(local.model) : local.engine;
      recordAiUsage({
        provider: "local-whisper",
        model,
        task: "transcribe",
        inChars: 0,
        outChars: r.text.length,
        usd: 0,
      });
      if (r.text.trim().length > 0) {
        const speechSec = r.segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
        return { ...r, source: "local-whisper", model, speechSec: speechSec || null };
      }
      // An empty local result is worse than none; fall through (if allowed)
      // rather than storing a blank transcript for an hour of audio.
      if (pref === "local") {
        throw new TranscriptionDeferred("no_recording", "No speech was heard in this recording.");
      }
    }
    if (pref === "local") {
      throw new TranscriptionDeferred(
        "needs_local",
        "Transcription is set to this machine only, and no local model is installed yet — install it from Settings → AI.",
      );
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new TranscriptionDeferred(
      "needs_local",
      "No way to transcribe: no local Whisper model and no OPENAI_API_KEY. Install the local model from Settings → AI to do it on this machine for free.",
    );
  }

  // Paid from here on, so work out what is actually worth paying for.
  const map = await speechSpans(audioPath);
  // Nearly nothing said in a long recording is an empty room. A short clip that
  // is all speech — a voice memo, an upload — is not, however few minutes it is.
  if (map.durationSec && map.speechSec < Math.min(MIN_SPEECH_SEC, map.durationSec * 0.1)) {
    throw new TranscriptionDeferred("no_recording", "The recording is almost entirely silent.");
  }
  const cost = estimateAudioCost(MODEL(), map.speechSec || map.durationSec);
  const left = remainingBudgetUsd();
  if (left != null && cost > left) {
    throw new TranscriptionDeferred(
      "over_budget",
      `Transcribing this would cost about $${cost.toFixed(2)}, and $${left.toFixed(2)} of this month's budget is left.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "uni-tr-"));
  try {
    // Only bother cutting when it saves something real; otherwise send as-is.
    const trimmed = map.durationSec > 0 && map.speechSec < map.durationSec * 0.95;
    const upload = trimmed ? join(dir, "speech.mp3") : audioPath;
    if (trimmed) await writeSpeechOnly(audioPath, map, upload);

    const raw = await transcribeChunked(upload, dir);
    const segments = trimmed ? remap(raw.segments, map) : raw.segments;
    return {
      text: raw.text,
      segments,
      source: "openai-whisper",
      model: MODEL(),
      speechSec: map.speechSec || null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function remap(segments: TranscriptSegment[], map: SpeechMap): TranscriptSegment[] {
  return segments.map((s) => ({
    ...s,
    start: toOriginalTime(map, s.start),
    end: toOriginalTime(map, s.end),
  }));
}

/** Files over the size limit are split into time chunks and stitched back with corrected timestamps. */
async function transcribeChunked(
  audioPath: string,
  dir: string,
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  if (statSync(audioPath).size <= MAX_BYTES) return transcribeOne(audioPath, 0);

  const chunks = await splitAudio(audioPath, CHUNK_SECONDS, dir, basename(audioPath, ".mp3"));
  const merged = { text: "", segments: [] as TranscriptSegment[] };
  let offset = 0;
  for (const chunk of chunks) {
    const part = await transcribeOne(chunk, offset);
    merged.text += (merged.text ? "\n" : "") + part.text;
    merged.segments.push(...part.segments);
    offset += (await probeDuration(chunk)) ?? CHUNK_SECONDS;
  }
  return merged;
}

async function transcribeOne(
  path: string,
  offsetSec: number,
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const buf = readFileSync(path);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), basename(path));
  form.append("model", MODEL());
  form.append("response_format", "verbose_json");
  form.append("language", "en");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`OpenAI transcription: ${json.error.message}`);

  // Logged so the audio half of the bill shows up next to the text half
  // instead of being invisible.
  recordAiUsage({
    provider: "openai-whisper",
    model: MODEL(),
    task: "transcribe",
    inChars: 0,
    outChars: String(json.text ?? "").length,
    usd: estimateAudioCost(MODEL(), (json.duration as number) ?? 0),
  });

  const segments: TranscriptSegment[] = (json.segments ?? []).map((s: any) => ({
    start: (s.start ?? 0) + offsetSec,
    end: (s.end ?? 0) + offsetSec,
    text: (s.text ?? "").trim(),
  }));
  return { text: (json.text ?? "").trim(), segments };
}
