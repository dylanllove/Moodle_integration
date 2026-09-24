import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedDataDir } from "./helpers.js";

isolatedDataDir();
const { parseTranscript } = await import("@uni/lms");
const { speechSpans, toOriginalTime } = await import("@uni/transcribe");
const { renderNotesMarkdown, clock } = await import("@uni/ai");

test("WebVTT captions keep their cue times", () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.500
Hello <v Speaker>everyone</v>

2
00:01:02.250 --> 00:01:05.000 align:start
Today we cover
net present value.
`;
  const c = parseTranscript(vtt)!;
  assert.equal(c.text, "Hello everyone Today we cover net present value.");
  assert.deepEqual(c.segments!.map((s) => [s.start, s.end]), [[1, 4.5], [62.25, 65]]);
});

test("SRT and Echo JSON cues are timed too; untimed cues aren't invented", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\n01:00:00,500 --> 01:00:01,000\nBye";
  assert.deepEqual(parseTranscript(srt)!.segments!.map((s) => s.start), [1, 3600.5]);
  const json = JSON.stringify({ data: [{ startMs: 1500, endMs: 3000, content: "a" }, { startMs: 4000, content: "b" }] });
  assert.deepEqual(parseTranscript(json)!.segments!.map((s) => s.start), [1.5, 4]);
  assert.equal(parseTranscript(JSON.stringify([{ text: "no times here" }]))!.segments, null);
});

test("Echo's transcript API response becomes words and times, not raw JSON", () => {
  const body = JSON.stringify({
    status: "ok",
    message: "",
    data: {
      id: "x",
      isAutomated: true,
      contentJSON: {
        cues: [
          { startMs: 1269, endMs: 13939, speaker: "Speaker 0", content: "Good morning everyone.", confidence: { average: 70 } },
          { startMs: 17159, endMs: 18000, speaker: "Speaker 0", content: "Today: capital structure.", confidence: { average: 80 } },
        ],
      },
    },
  });
  const c = parseTranscript(body)!;
  assert.equal(c.text, "Good morning everyone. Today: capital structure.");
  assert.deepEqual(c.segments!.map((s) => s.start), [1.269, 17.159]);
  // Anything else that parses as JSON but isn't a transcript is refused outright.
  assert.equal(parseTranscript(JSON.stringify({ status: "ok", data: { id: "x" } })), null);
});

test("speech-only time maps back to the original recording", () => {
  const map = { spans: [{ start: 100, end: 160 }, { start: 400, end: 500 }], speechSec: 160, durationSec: 600 };
  assert.equal(toOriginalTime(map, 0), 100);
  assert.equal(toOriginalTime(map, 59), 159);
  assert.equal(toOriginalTime(map, 60), 400);
  assert.equal(toOriginalTime(map, 110), 450);
});

test("silence detection finds the talking and drops the empty room", async () => {
  // 20 s of tone, 30 s of silence, 20 s of tone — a lecture with a long break.
  const f = join(mkdtempSync(join(tmpdir(), "uni-audio-")), "room.mp3");
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=20",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=30",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=20",
    "-filter_complex", "[0:a]aresample=16000,aformat=channel_layouts=mono[a];[1:a]aformat=channel_layouts=mono[b];[2:a]aresample=16000,aformat=channel_layouts=mono[c];[a][b][c]concat=n=3:v=0:a=1",
    "-y", f,
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  const m = await speechSpans(f);
  assert.equal(m.spans.length, 2);
  assert.ok(Math.abs(m.durationSec - 70) <= 1);
  // Two 20 s stretches plus padding either side — not the 30 s gap.
  assert.ok(m.speechSec > 40 && m.speechSec < 46, `speech ${m.speechSec}`);
  assert.ok(m.spans[1]!.start > 45 && m.spans[1]!.start < 51, `second span ${m.spans[1]!.start}`);
});

test("notes render from structured data with the right kind of anchor", () => {
  const a = {
    tldr: "T",
    topics: [],
    sections: [],
    concepts: [
      { kind: "concept" as const, name: "NPV", explanation: "Value today.", section: -1, start: 75 },
      { kind: "term" as const, name: "IRR", explanation: "Break-even rate.", section: -1, start: null },
    ],
    emphasis: [],
    questions: [{ q: "What is NPV?", a: "Value today.", concept: "NPV", start: 75 }],
  };
  const timed = renderNotesMarkdown(a, "seconds");
  assert.match(timed, /\*\*NPV\*\* — Value today\. _\(1:15\)_/);
  assert.match(timed, /## Key terms\n- \*\*IRR\*\*/);
  assert.match(timed, /None flagged explicitly/);
  assert.match(renderNotesMarkdown(a, "page"), /_\(slide 75\)_/);
  assert.equal(clock(3725), "1:02:05");
});
