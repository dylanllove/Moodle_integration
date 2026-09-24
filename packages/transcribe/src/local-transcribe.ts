import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataDir, type TranscriptSegment } from "@uni/db";
import { extractAudio } from "./ffmpeg.js";

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
  /** Silero VAD model for whisper.cpp, when present — skips dead air. */
  vadModel: string | null;
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

/**
 * The models this app installs for itself. large-v3-turbo quantised to q5_0 is
 * about 550 MB, close to large-v3 on lecture English, and runs several times
 * faster than real time on Apple silicon. The VAD model is under a megabyte.
 */
const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
export const WHISPER_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
export const VAD_MODEL_FILE = "ggml-silero-v5.1.2.bin";
const DOWNLOADS: Record<string, string> = {
  [WHISPER_MODEL_FILE]: `${HF}/${WHISPER_MODEL_FILE}`,
  [VAD_MODEL_FILE]: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
};

const modelsDir = () => join(dataDir(), "models");

/** A model file for whisper.cpp, which needs one passed explicitly. */
function findModel(): string | null {
  const explicit = process.env.WHISPER_MODEL;
  if (explicit && existsSync(explicit)) return explicit;
  const guesses = [
    join(modelsDir(), WHISPER_MODEL_FILE),
    join(modelsDir(), "ggml-large-v3-turbo.bin"),
    "models/ggml-large-v3-turbo.bin",
    "models/ggml-medium.en.bin",
    "models/ggml-base.en.bin",
    `${process.env.HOME}/.whisper/ggml-large-v3-turbo.bin`,
    `${process.env.HOME}/.whisper/ggml-base.en.bin`,
    "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
  ];
  return guesses.find((g) => existsSync(g)) ?? null;
}

function findVadModel(): string | null {
  const p = join(modelsDir(), VAD_MODEL_FILE);
  return existsSync(p) ? p : null;
}

/** whisper.cpp's binary, whether or not a model is installed for it yet. */
export async function whisperCppBinary(): Promise<string | null> {
  for (const name of CANDIDATES[0]!.names) {
    const found = await which(name);
    if (found) return found;
  }
  return null;
}

export interface InstallProgress {
  file: string;
  state: "idle" | "downloading" | "done" | "error";
  bytes: number;
  total: number | null;
  error?: string;
}

let install: InstallProgress = { file: WHISPER_MODEL_FILE, state: "idle", bytes: 0, total: null };
let installing: Promise<void> | null = null;

export function whisperInstallProgress(): InstallProgress {
  return install;
}

/**
 * Download the local transcription models into the data directory, so "install
 * whisper.cpp" is the student's only setup step instead of also hunting for a
 * model file. Single-flight: a second click joins the download in progress.
 * Streams to a .part file and renames, so a lid closed half-way leaves nothing
 * that looks like a model.
 */
export function ensureWhisperModel(): Promise<void> {
  if (installing) return installing;
  installing = (async () => {
    mkdirSync(modelsDir(), { recursive: true });
    for (const file of [VAD_MODEL_FILE, WHISPER_MODEL_FILE]) {
      const dest = join(modelsDir(), file);
      if (existsSync(dest) && statSync(dest).size > 0) continue;
      install = { file, state: "downloading", bytes: 0, total: null };
      const res = await fetch(DOWNLOADS[file]!, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`Downloading ${file}: HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length"));
      install.total = Number.isFinite(len) && len > 0 ? len : null;
      const part = `${dest}.part`;
      const body = Readable.fromWeb(res.body as any);
      body.on("data", (chunk: Buffer) => (install.bytes += chunk.length));
      await pipeline(body, createWriteStream(part));
      renameSync(part, dest);
    }
    install = { ...install, state: "done" };
    cached = null; // the next probe should see the new model straight away
  })()
    .catch((e) => {
      install = { ...install, state: "error", error: String(e instanceof Error ? e.message : e) };
      throw e;
    })
    .finally(() => {
      installing = null;
    });
  return installing;
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
      found = {
        engine: candidate.engine,
        binary,
        model,
        vadModel: candidate.engine === "whisper-cpp" ? findVadModel() : null,
      };
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
      // whisper.cpp builds differ on what they'll decode; 16 kHz mono WAV is the
      // one input every build accepts.
      const wav = `${stem}.wav`;
      await extractAudio(audioPath, wav);
      // -oj writes <stem>.json alongside; -np keeps stdout quiet. VAD skips the
      // dead air either side of the lecture — faster, and no hallucinated
      // "Thank you." lines over twenty minutes of an empty room — while keeping
      // timestamps on the original recording's clock.
      const vad = transcriber.vadModel ? ["--vad", "-vm", transcriber.vadModel] : [];
      await run(
        transcriber.binary,
        ["-m", transcriber.model!, "-f", wav, "-oj", "-of", stem, "-np", "-l", "en", ...vad],
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
