import { spawn } from "node:child_process";

/** Run ffmpeg/ffprobe with args, resolving stdout; rejects on non-zero exit. */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(new Error(`${bin} not found — install it (e.g. 'brew install ffmpeg'). ${e.message}`)),
    );
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} failed: ${err.slice(-500)}`))));
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
 * transcription API. A 60-min lecture lands around ~15MB at 32kbps.
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
  args.push("-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-y", outMp3);
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
