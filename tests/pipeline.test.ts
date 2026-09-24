import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fakeOllama, isolatedDataDir } from "./helpers.js";

/**
 * The whole lecture pipeline, end to end, on a real recording:
 *   audio → local Whisper → stored transcript with timestamps → one structured
 *   analysis → tables + rendered notes + flashcard deck → search index →
 *   a citation that opens the lecture at the right second.
 *
 * Nothing is paid for and nothing real is touched: the data directory is
 * temporary, the AI is a local stand-in, and the audio is the sample clip
 * that ships with whisper.cpp.
 */

const dataDir = isolatedDataDir();
const model = await fakeOllama();
process.env.AI_LOCAL_URL = model.url;
process.env.AI_LOCAL_MODEL = "fake:latest";
delete process.env.OPENAI_API_KEY;
after(() => model.close());

const { getDb, setSetting } = await import("@uni/db");
const { localTranscriber, transcribeFile, TranscriptionDeferred } = await import("@uni/transcribe");
const { indexAll, retrieve } = await import("@uni/ai");
const { transcribeLectureNow, transcribingNow } = await import("../apps/server/src/transcripts.js");
const { describeSource } = await import("../apps/server/src/sources.js");

setSetting("ai_provider", "local");
setSetting("transcribe_provider", "local");

const quietLog = { info() {}, warn() {}, error() {} };
const app = { log: quietLog } as any;

const SAMPLE = "/opt/homebrew/share/whisper-cpp/jfk.wav";
const haveSample = existsSync(SAMPLE);
const haveLocal = Boolean(await localTranscriber(true)) && haveSample;
const needsSample = !haveSample && "needs the whisper.cpp sample audio (brew install whisper-cpp)";

/**
 * The 11 s sample three times, with 12 s of silence between — a (very) short
 * lecture with pauses, so there's something for VAD to skip and the timeline
 * spans more than one line.
 */
function lectureAudio(name = "speech.mp3"): string {
  const out = join(dataDir, name);
  const gap = ["-f", "lavfi", "-t", "12", "-i", "anullsrc=r=16000:cl=mono"];
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", SAMPLE, ...gap, "-i", SAMPLE, ...gap, "-i", SAMPLE,
    "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1", "-ac", "1", "-ar", "16000", "-y", out,
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

async function settled(id: string): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (transcribingNow().includes(id)) {
    if (Date.now() > deadline) throw new Error("transcription never finished");
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("a recording becomes timestamped, structured, searchable study material", { skip: !haveLocal && "needs whisper.cpp and its model" }, async () => {
  const db = getDb();
  const id = "upload:test-lecture";
  db.prepare("INSERT INTO courses (id, lms, name, code, start_date) VALUES ('c1','moodle','Rhetoric','RHET101', ?)").run(
    new Date(Date.now() - 20 * 864e5).toISOString(),
  );
  db.prepare("INSERT INTO lectures (id, course_id, title, provider, media_path, recorded_at) VALUES (?,?,?,?,?,?)").run(
    id, "c1", "Inaugural address", "upload", lectureAudio(), new Date(Date.now() - 864e5).toISOString(),
  );

  assert.deepEqual(transcribeLectureNow(app, id), { queued: true });
  await settled(id);

  // --- Transcript: made on this machine, for free, with timings ---
  const t = db.prepare("SELECT * FROM transcripts WHERE lecture_id = ?").get(id) as any;
  assert.equal(t.status, "done", t.error ?? "");
  assert.equal(t.source, "upload");
  assert.match(t.model, /ggml/);
  assert.match(t.text, /ask not what your country can do for you/i);
  const segments = JSON.parse(t.segments) as { start: number; end: number }[];
  assert.ok(segments.length >= 3);
  assert.ok(segments.at(-1)!.end > 50, "timestamps stay on the recording's clock, pauses included");
  const usage = db.prepare("SELECT provider, usd FROM ai_usage WHERE task = 'transcribe'").all() as any[];
  assert.deepEqual(usage.map((u) => [u.provider, u.usd]), [["local-whisper", 0]]);
  // The upload itself is left where the student put it, and still recorded there.
  assert.ok(existsSync(join(dataDir, "speech.mp3")));
  const lec = db.prepare("SELECT media_path, duration_sec FROM lectures WHERE id = ?").get(id) as any;
  assert.equal(lec.media_path, join(dataDir, "speech.mp3"));
  assert.ok(lec.duration_sec > 50);
  assert.ok(t.speech_sec > 20 && t.speech_sec < lec.duration_sec, "speech time excludes the pauses");

  // --- One structured analysis, sent with a schema and a big enough context ---
  const analysis = model.calls.filter((c) => (c.format as any)?.properties?.sections);
  assert.equal(analysis.length, 1, "exactly one analysis call");
  assert.ok((analysis[0]!.numCtx ?? 0) >= 4096);
  assert.match(analysis[0]!.prompt, /^\[0\|0:0\d\]/m, "lines are numbered and timed");

  const digest = db.prepare("SELECT * FROM lecture_digests WHERE lecture_id = ?").get(id) as any;
  assert.equal(digest.anchor, "seconds");
  assert.equal(digest.week, 3);
  const sections = db.prepare("SELECT * FROM lecture_sections WHERE lecture_id = ? ORDER BY idx").all(id) as any[];
  assert.equal(sections.length, 2);
  assert.ok(sections[1].start_sec > 15, "a line number came back as seconds into the recording");
  assert.equal(sections[0].end_sec, sections[1].start_sec);
  const concepts = db.prepare("SELECT * FROM lecture_concepts WHERE lecture_id = ?").all(id) as any[];
  assert.ok(concepts.every((c) => c.section_id), "concepts are linked to their sections");
  const questions = db.prepare("SELECT * FROM lecture_questions WHERE lecture_id = ?").all(id) as any[];
  assert.equal(questions.length, 4);
  assert.equal(questions.find((q) => /anchored/.test(q.question)).start_sec, null, "bad line → no timestamp");
  assert.ok(questions.filter((q) => q.concept_id).length >= 3, "questions know which concept they test");

  // --- The notes everything else reads are rendered from those rows ---
  const summary = (db.prepare("SELECT summary FROM transcripts WHERE lecture_id = ?").get(id) as any).summary;
  assert.match(summary, /^## TL;DR\nA speech about civic duty\./);
  assert.match(summary, /\*\*Civic duty\*\* — Contributing to your country\. _\(0:\d\d\)_/);

  // --- A deck, from the same call ---
  const deck = db.prepare("SELECT d.id, COUNT(c.id) n FROM decks d JOIN cards c ON c.deck_id = d.id WHERE d.lecture_id = ? GROUP BY d.id").get(id) as any;
  assert.equal(deck?.n, 4);

  // --- Search finds it, at the moment it was said ---
  const first = indexAll();
  assert.ok(first.chunks > 0);
  assert.equal(indexAll().changed, 0, "re-indexing unchanged material changes nothing");
  const hit = retrieve("ask what you can do for your country", null, 5).find((c) => c.lectureId === id && c.startSec != null);
  assert.ok(hit, "a timestamped chunk from this lecture");
  const ref = describeSource(hit!.sourceType, hit!.sourceId, hit!.startSec)!;
  assert.match(ref.label, /^Inaugural address · \d+:\d\d$/);
  assert.match(ref.to!, /^\/lectures\?lecture=upload%3Atest-lecture&t=\d+$/);

  // --- Asking again doesn't redo the work ---
  const before = model.calls.length;
  const { generateLectureNotes } = await import("../apps/server/src/notes-gen.js");
  await generateLectureNotes(id);
  assert.equal(model.calls.length, before, "an unchanged transcript is answered from the cache");
});

test("a failed notes step never undoes a finished transcript", { skip: !haveLocal && "needs whisper.cpp and its model" }, async () => {
  const db = getDb();
  const id = "upload:notes-fail";
  db.prepare("INSERT INTO lectures (id, title, provider, media_path) VALUES (?,?,?,?)").run(
    id, "Notes will fail", "upload", lectureAudio("notes-fail.mp3"),
  );
  model.failing = true;
  try {
    transcribeLectureNow(app, id);
    await settled(id);
  } finally {
    model.failing = false;
  }
  const t = db.prepare("SELECT status, text, summary FROM transcripts WHERE lecture_id = ?").get(id) as any;
  assert.equal(t.status, "done", "the transcript stands even though notes failed");
  assert.match(t.text, /your country/i);
  assert.equal(t.summary, null, "notes are left for the backfill to retry");
});

test("the paid path refuses to go over budget, before sending anything", { skip: needsSample }, async () => {
  setSetting("transcribe_provider", "openai");
  setSetting("ai_budget_usd", "0.0001");
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  const realFetch = globalThis.fetch;
  let sent = false;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).includes("api.openai.com")) sent = true;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    await assert.rejects(transcribeFile(lectureAudio("budget.mp3")), (e: any) => {
      assert.ok(e instanceof TranscriptionDeferred);
      assert.equal(e.reason, "over_budget");
      return true;
    });
    assert.equal(sent, false, "no audio left the machine");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
    setSetting("transcribe_provider", "local");
  }
});

test("local-only never falls back to paying", { skip: needsSample }, async () => {
  setSetting("transcribe_provider", "local");
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  const audio = lectureAudio("local-only.mp3");
  const saved = process.env.PATH;
  // With no whisper.cpp on the PATH there is no local transcriber at all.
  process.env.PATH = "/nonexistent";
  const { localTranscriber: probe } = await import("@uni/transcribe");
  await probe(true);
  try {
    await assert.rejects(transcribeFile(audio), (e: any) => e?.reason === "needs_local");
  } finally {
    process.env.PATH = saved;
    delete process.env.OPENAI_API_KEY;
    await probe(true);
  }
});
