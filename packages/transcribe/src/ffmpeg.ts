import { spawn } from "node:child_process";

/** Run ffmpeg/ffprobe with args, resolving stdout; rejects on non-zero exit. */
function run(bin: string, args: string[]): Promise<string> {
  return runBoth(bin, args).then((r) => r.out);
}

/** The same, keeping stderr too — where ffmpeg's filters write what they found. */
function runBoth(bin: string, args: string[]): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(new Error(`${bin} not found — install it (e.g. 'brew install ffmpeg'). ${e.message}`)),
    );
    p.on("close", (code) =>
      code === 0 ? resolve({ out, err }) : reject(new Error(`${bin} failed: ${err.slice(-500)}`)),
    );
  });
}

/**
 * Extract mono 16 kHz PCM WAV from any audio/video source (a local file OR a
 * remote URL, including HLS .m3u8 streams) — the format Whisper expects.
 * `headers` are passed to ffmpeg for authenticated remote streams.
 */
export async function extractAudio(
  input: string,
  outWav: string,
  headers?: Record<string, string>,
): Promise<void> {
  const args: string[] = [];
  if (headers && Object.keys(headers).length) {
    const blob = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    args.push("-headers", blob + "\r\n");
  }
  args.push("-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outWav);
  await run("ffmpeg", args);
}

/**
 * Extract mono 16kHz MP3 (low bitrate) — small enough to upload to a
 * transcription API. 24 kbps is ~10.8 MB an hour, so even a two-hour room booking
 * goes up in one request instead of six; speech at 16 kHz loses nothing Whisper
 * uses at that rate.
 */
export async function extractAudioMp3(
  input: string,
  outMp3: string,
  headers?: Record<string, string>,
): Promise<void> {
  const args: string[] = [];
  if (headers && Object.keys(headers).length) {
    const blob = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    args.push("-headers", blob + "\r\n");
  }
  args.push("-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "24k", "-y", outMp3);
  await run("ffmpeg", args);
}

/**
 * Split an audio file into fixed-length segments (seconds). Returns the ordered
 * list of chunk paths. Used to stay under the transcription API size limit.
 */
export async function splitAudio(
  input: string,
  segmentSeconds: number,
  outDir: string,
  prefix: string,
): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const pattern = join(outDir, `${prefix}-%03d.mp3`);
  await run("ffmpeg", [
    "-i",
    input,
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    "-c",
    "copy",
    "-y",
    pattern,
  ]);
  return readdirSync(outDir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".mp3"))
    .sort()
    .map((f) => join(outDir, f));
}

/** Duration in seconds, or null if it can't be determined. */
export async function probeDuration(input: string): Promise<number | null> {
  try {
    const out = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      input,
    ]);
    const n = parseFloat(out.trim());
    return isNaN(n) ? null : Math.round(n);
  } catch {
    return null;
  }
}

/* --- Speech, as opposed to a recording -------------------------------------- */

/**
 * Where in a recording someone is actually talking.
 *
 * Lecture capture records the whole room booking: a 14:00–15:55 slot is 115
 * minutes of audio for a lecture that runs 50, and every minute of the empty room
 * either side is billed at the same rate as the lecture. This finds the long
 * silences with ffmpeg (free, local, a few seconds for two hours of audio) so the
 * paid path only sends what's spoken.
 */
export interface SpeechMap {
  /** Spoken stretches, in seconds of the original recording, in order. */
  spans: { start: number; end: number }[];
  speechSec: number;
  durationSec: number;
}

export async function speechSpans(
  input: string,
  opts: { noiseDb?: number; minSilenceSec?: number; padSec?: number } = {},
): Promise<SpeechMap> {
  // Tuned on real recordings against their whisper-1 transcripts: this bills
  // ~87% of recorded minutes and drops ~0.7% of transcript text — most of which
  // was Whisper hallucinating over an empty room ("Diolch yn fawr iawn…").
  const noise = opts.noiseDb ?? -45;
  // Long enough that ordinary pauses for breath, a question or a slide change
  // stay in; what goes is the room before and after, and the break in the middle.
  const minSilence = opts.minSilenceSec ?? 6;
  const pad = opts.padSec ?? 1.5;
  const durationSec = (await probeDuration(input)) ?? 0;
  const { err } = await runBoth("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    input,
    "-af",
    `silencedetect=n=${noise}dB:d=${minSilence}`,
    "-f",
    "null",
    "-",
  ]);

  const silences: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of err.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, parseFloat(s[1]!));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open != null) {
      silences.push({ start: open, end: parseFloat(e[1]!) });
      open = null;
    }
  }
  // A recording that ends in silence reports a start with no end.
  if (open != null && durationSec) silences.push({ start: open, end: durationSec });

  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const sil of silences) {
    if (sil.start > cursor) spans.push({ start: cursor, end: sil.start });
    cursor = sil.end;
  }
  if (durationSec > cursor) spans.push({ start: cursor, end: durationSec });

  // Pad each edge so a first syllable isn't clipped, then merge what now overlaps.
  const padded: { start: number; end: number }[] = [];
  for (const sp of spans) {
    const start = Math.max(0, sp.start - pad);
    const end = durationSec ? Math.min(durationSec, sp.end + pad) : sp.end + pad;
    const last = padded[padded.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else padded.push({ start, end });
  }
  const speechSec = padded.reduce((n, sp) => n + (sp.end - sp.start), 0);
  return { spans: padded, speechSec, durationSec };
}

/** Write just the spoken spans of `input` back-to-back, as upload-sized MP3. */
export async function writeSpeechOnly(input: string, map: SpeechMap, outMp3: string): Promise<void> {
  const keep = map.spans.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join("+");
  await run("ffmpeg", [
    "-hide_banner",
    "-i",
    input,
    "-vn",
    "-af",
    `aselect='${keep}',asetpts=N/SR/TB`,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "24k",
    "-y",
    outMp3,
  ]);
}

/**
 * Seconds in the speech-only file → seconds in the original recording, so a
 * timestamp still opens the lecture at the moment it was said.
 */
export function toOriginalTime(map: SpeechMap, t: number): number {
  let cum = 0;
  for (const sp of map.spans) {
    const len = sp.end - sp.start;
    if (t < cum + len) return sp.start + (t - cum);
    cum += len;
  }
  const last = map.spans[map.spans.length - 1];
  return last ? last.end : t;
}
