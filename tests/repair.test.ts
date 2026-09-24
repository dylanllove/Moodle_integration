import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isolatedDataDir } from "./helpers.js";

/**
 * The startup repairs, against data in the shapes older versions wrote. Each
 * must fix what's broken, leave everything else alone, and be safe to run again.
 */
const dataDir = isolatedDataDir();
const { getDb } = await import("@uni/db");
const { repairData } = await import("../apps/server/src/repair.js");
const app = { log: { info() {}, warn() {}, error() {} } } as any;
const db = getDb();

const rawCaptions = JSON.stringify({
  status: "ok",
  data: {
    contentJSON: {
      cues: Array.from({ length: 60 }, (_, i) => ({
        startMs: i * 10_000,
        endMs: i * 10_000 + 9_000,
        content: `Sentence number ${i} about capital structure and the cost of debt.`,
      })),
    },
  },
});

test("startup repairs fix old data and leave good data alone", async () => {
  db.exec(`
    INSERT INTO lectures (id, title, provider) VALUES
      ('echo360:raw', 'Raw captions', 'echo360'),
      ('echo360:old', 'Old whisper', 'echo360'),
      ('echo360:busy', 'Still transcribing', 'echo360'),
      ('upload:mine', 'My upload', 'upload');
  `);
  db.prepare("INSERT INTO transcripts (id, lecture_id, status, text) VALUES ('tr:echo360:raw','echo360:raw','done',?)").run(rawCaptions);
  db.prepare(
    "INSERT INTO transcripts (id, lecture_id, status, text, segments) VALUES ('tr:echo360:old','echo360:old','done','Old words.','[{\"start\":0,\"end\":1,\"text\":\"Old words.\"}]')",
  ).run();
  db.prepare("INSERT INTO transcripts (id, lecture_id, status) VALUES ('tr:echo360:busy','echo360:busy','transcribing')").run();

  // A deck made from the raw response, never studied — and one that has been.
  db.exec(`
    INSERT INTO decks (id, lecture_id, title, source) VALUES ('d-raw','echo360:raw','Raw','lecture'), ('d-old','echo360:old','Old','lecture');
    INSERT INTO cards (id, deck_id, q, a) VALUES ('c1','d-raw','q','a');
    INSERT INTO cards (id, deck_id, q, a, reviews) VALUES ('c2','d-old','q','a', 3);
  `);

  // Leftover audio: one finished lecture's, one still in progress, one unknown.
  const media = join(dataDir, "media");
  mkdirSync(media, { recursive: true });
  for (const f of ["echo360_old.mp3", "echo360_busy.mp3", "something-else.mp3"]) writeFileSync(join(media, f), "x");

  // A course file recorded under the app's previous location.
  const moved = join(dataDir, "materials", "COSC101", "Week 01");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, "intro.pdf"), "%PDF");
  db.prepare("INSERT INTO materials (id, title, path) VALUES ('m1','intro.pdf',?)").run(
    "/Users/someone/Old-Place/data/materials/COSC101/Week 01/intro.pdf",
  );

  await repairData(app);

  const raw = db.prepare("SELECT * FROM transcripts WHERE lecture_id = 'echo360:raw'").get() as any;
  assert.match(raw.text, /^Sentence number 0 about capital structure/);
  assert.equal(raw.source, "captions");
  assert.equal(JSON.parse(raw.segments)[5].start, 50);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM decks WHERE id = 'd-raw'").get()!.n, 0, "unstudied deck from garbage is dropped");

  const old = db.prepare("SELECT * FROM transcripts WHERE lecture_id = 'echo360:old'").get() as any;
  assert.equal(old.source, "openai-whisper");
  assert.equal(old.text, "Old words.");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM decks WHERE id = 'd-old'").get()!.n, 1, "studied deck is never touched");

  assert.equal(existsSync(join(media, "echo360_old.mp3")), false, "finished lecture's audio swept");
  assert.equal(existsSync(join(media, "echo360_busy.mp3")), true, "in-progress audio kept");
  assert.equal(existsSync(join(media, "something-else.mp3")), true, "unknown files kept");

  const m = db.prepare("SELECT path FROM materials WHERE id = 'm1'").get() as any;
  assert.equal(m.path, join(moved, "intro.pdf"));

  // Running again changes nothing.
  const before = JSON.stringify(db.prepare("SELECT * FROM transcripts ORDER BY id").all());
  await repairData(app);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM transcripts ORDER BY id").all()), before);
});
