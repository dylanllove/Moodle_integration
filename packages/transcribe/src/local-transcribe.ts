import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { TranscriptSegment } from "@uni/db";

const run = promisify(execFile);

/**
 * Transcribe on this machine instead of paying per minute.
 *
 * Lecture audio is the single largest line on the bill — 27 hours of recordings
 * is about ten dollars through the API, and it grows every week of term. The same
 * work runs locally for nothing, and on Apple silicon it runs faster than
 * real time, so the only reason to send audio away is not having a local
 * transcriber installed.
 *
 * Supports whisper.cpp (`whisper-cli`, or the older `main`) and the `whisper`
 * Python CLI, because which one someone has is a coin toss and both are one brew
 * or pip away.
 */
export type LocalEngine = "whisper-cpp" | "whisper-python";

export interface LocalTranscriber {
  engine: LocalEngine;
  binary: string;
  model: string | null;
}

const CANDIDATES: { engine: LocalEngine; names: string[] }[] = [
  { engine: "whisper-cpp", names: ["whisper-cli", "whisper-cpp", "main"] },
  { engine: "whisper-python", names: ["whisper"] },
];

async function which(name: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/which", [name]);
    const path = stdout.trim();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** A model file for whisper.cpp, which needs one passed explicitly. */
function findModel(): string | null {
  const explicit = process.env.WHISPER_MODEL;
  if (explicit && existsSync(explicit)) return explicit;
  const guesses = [
    "models/ggml-large-v3-turbo.bin",
    "models/ggml-medium.en.bin",
    "models/ggml-base.en.bin",
    `${process.env.HOME}/.whisper/ggml-large-v3-turbo.bin`,
    `${process.env.HOME}/.whisper/ggml-base.en.bin`,
    "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
  ];
  return guesses.find((g) => existsSync(g)) ?? null;
}

let cached: { at: number; found: LocalTranscriber | null } | null = null;
const TTL_MS = 60_000;

/** What's installed, if anything. Cheap to call repeatedly. */
export async function localTranscriber(force = false): Promise<LocalTranscriber | null> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.found;

  let found: LocalTranscriber | null = null;
  for (const candidate of CANDIDATES) {
    for (const name of candidate.names) {
      const binary = await which(name);
      if (!binary) continue;
      const model = candidate.engine === "whisper-cpp" ? findModel() : null;
      // whisper.cpp without a model file can't do anything, so it doesn't count
      // as installed — better to fall through than fail at transcription time.
      if (candidate.engine === "whisper-cpp" && !model) continue;
      found = { engine: candidate.engine, binary, model };
      break;
    }
    if (found) break;
  }
  cached = { at: Date.now(), found };
  return found;
}

export interface LocalResult {
  text: string;
  segments: TranscriptSegment[];
}

export async function transcribeLocally(
  audioPath: string,
  transcriber: LocalTranscriber,
): Promise<LocalResult> {
  const dir = mkdtempSync(join(tmpdir(), "uni-local-tr-"));
  const stem = join(dir, basename(audioPath).replace(/\.[^.]+$/, ""));
  try {
    if (transcriber.engine === "whisper-cpp") {
      // -oj writes <stem>.json alongside; -np keeps stdout quiet.
      await run(
        transcriber.binary,
        ["-m", transcriber.model!, "-f", audioPath, "-oj", "-of", stem, "-np", "-l", "en"],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return readWhisperCppJson(`${stem}.json`);
    }

    await run(
      transcriber.binary,
      [audioPath, "--model", process.env.WHISPER_PY_MODEL || "base.en", "--output_format", "json", "--output_dir", dir, "--language", "en"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return readWhisperPythonJson(`${stem}.json`);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is not worth failing over */
    }
  }
}

/** whisper.cpp: { transcription: [{ offsets: {from,to}, text }] }, ms offsets. */
function readWhisperCppJson(path: string): LocalResult {
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    transcription?: { offsets?: { from: number; to: number }; text?: string }[];
  };
  const segments: TranscriptSegment[] = (json.transcription ?? []).map((s) => ({
    start: (s.offsets?.from ?? 0) / 1000,
    end: (s.offsets?.to ?? 0) / 1000,
    text: (s.text ?? "").trim(),
  }));
  return { text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(), segments };
}

/** The Python CLI: { text, segments: [{start,end,text}] }, seconds. */
function readWhisperPythonJson(path: string): LocalResult {
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    text?: string;
    segments?: { start: number; end: number; text: string }[];
  };
  const segments: TranscriptSegment[] = (json.segments ?? []).map((s) => ({
    start: s.start ?? 0,
    end: s.end ?? 0,
    text: (s.text ?? "").trim(),
  }));
  return { text: (json.text ?? segments.map((s) => s.text).join(" ")).trim(), segments };
}
