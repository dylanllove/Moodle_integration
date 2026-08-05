/**
 * SQLite schema for the Uni Study app. Applied idempotently on startup.
 * Everything lives locally; no cloud storage.
 */
export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,          -- stable id derived from LMS course url/id
  lms         TEXT NOT NULL,             -- 'moodle' | 'blackboard'
  name        TEXT NOT NULL,
  code        TEXT,                      -- e.g. COMP1010
  url         TEXT,
  color       TEXT,                      -- hex, for calendar/UI
  start_date  TEXT,                      -- ISO, course start
  end_date    TEXT,                      -- ISO, course end
  active      INTEGER NOT NULL DEFAULT 1, -- auto-computed: currently running?
  active_override INTEGER,               -- null=auto, 1/0=user override
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id           TEXT PRIMARY KEY,
  course_id    TEXT REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  brief        TEXT,                     -- description / instructions text
  url          TEXT,
  due_at       TEXT,                     -- ISO8601, may be null
  open_at      TEXT,                     -- ISO8601, submissions-open date
  status       TEXT NOT NULL DEFAULT 'open', -- open | submitted | graded
  attachments  TEXT,                     -- JSON array of {name,url}
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lectures (
  id            TEXT PRIMARY KEY,
  course_id     TEXT REFERENCES courses(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  url           TEXT,                    -- LMS page or embed url
  media_url     TEXT,                    -- resolved direct media url if known
  provider      TEXT,                    -- panopto | echo360 | kaltura | direct
  recorded_at   TEXT,
  media_path    TEXT,                    -- local path once downloaded
  duration_sec  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transcripts (
  id           TEXT PRIMARY KEY,
  lecture_id   TEXT UNIQUE REFERENCES lectures(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | downloading | transcribing | done | error
  text         TEXT,                     -- full plain text
  segments     TEXT,                     -- JSON array of {start,end,text}
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  course_id    TEXT REFERENCES courses(id) ON DELETE SET NULL,
  lecture_id   TEXT REFERENCES lectures(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '', -- markdown
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unified calendar events (assignment due dates + iCal feed items), deduped.
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,         -- dedupe key (uid or hash)
  course_id    TEXT REFERENCES courses(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'deadline', -- deadline | class | exam | other
  source       TEXT NOT NULL,            -- ical | assignment | manual | timetable | echo360
  start_at     TEXT NOT NULL,            -- ISO8601
  end_at       TEXT,
  url          TEXT,
  location     TEXT,                     -- room/venue for classes
  notes        TEXT,                     -- extra detail (staff, activity type, compulsory)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chunked embeddings for retrieval over the student's own notes/transcripts.
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,             -- note | transcript
  source_id   TEXT NOT NULL,
  course_id   TEXT,
  text        TEXT NOT NULL,
  embedding   BLOB,                      -- Float32 vector
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Course prose (forum posts, labels, section summaries) for grounded Q&A.
CREATE TABLE IF NOT EXISTS course_text (
  id          TEXT PRIMARY KEY,
  course_id   TEXT REFERENCES courses(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,             -- forum | label | section | intro
  title       TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Course files (slides, readings, handouts) downloaded and filed by course/week.
CREATE TABLE IF NOT EXISTS materials (
  id           TEXT PRIMARY KEY,          -- moodle:file:<cmid>:<filename-hash>
  course_id    TEXT REFERENCES courses(id) ON DELETE CASCADE,
  week         INTEGER,                   -- inferred teaching week, null = unfiled
  section      TEXT,                      -- LMS section name the file sat under
  module       TEXT,                      -- LMS activity name
  title        TEXT NOT NULL,             -- original filename
  kind         TEXT NOT NULL DEFAULT 'other', -- slides | reading | sheet | data | other
  mimetype     TEXT,
  source_url   TEXT,                      -- LMS download url (token-bearing)
  path         TEXT,                      -- local file path once downloaded
  bytes        INTEGER,
  modified_at  TEXT,                      -- LMS timemodified, drives re-download
  text         TEXT,                      -- extracted text (slides/PDF) for study use
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Graded items with weightings — the input to the "what do I need on the final?"
-- calculator. Seeded from the Moodle gradebook, editable by hand.
CREATE TABLE IF NOT EXISTS assessments (
  id            TEXT PRIMARY KEY,
  course_id     TEXT REFERENCES courses(id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  group_id      TEXT REFERENCES assessment_groups(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  weight        REAL,                     -- % of the final grade; null in a group = equal share
  score         REAL,                     -- marks earned, null = not marked yet
  max_score     REAL,                     -- marks available (defaults to 100)
  due_at        TEXT,
  is_final      INTEGER NOT NULL DEFAULT 0, -- the item the calculator solves for
  is_bonus      INTEGER NOT NULL DEFAULT 0, -- extra credit: adds points, not part of the 100
  min_percent   REAL,                     -- hurdle you must clear on this item regardless
  source        TEXT NOT NULL DEFAULT 'manual', -- gradebook | assignment | manual
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A weighted bundle of assessments — "Labs 20% total, best 8 of 10".
-- Courses weight this way constantly and it can't be expressed per-item without
-- doing division by hand (and redoing it every time an item is added).
CREATE TABLE IF NOT EXISTS assessment_groups (
  id          TEXT PRIMARY KEY,
  course_id   TEXT REFERENCES courses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  weight      REAL,                       -- % of the final grade for the whole bundle
  drop_lowest INTEGER NOT NULL DEFAULT 0, -- how many worst results are discarded
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Life outside class: recurring commitments (shifts, sport, care) and one-offs.
-- Materialised into the events table with source='personal' so the calendar,
-- heatmap, .ics feed and digest all see them without special-casing.
CREATE TABLE IF NOT EXISTS commitments (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'other', -- work | sport | social | care | travel | other
  weekdays    TEXT,                       -- JSON [0-6], Sun=0; null/[] = one-off
  start_time  TEXT,                       -- "18:00" local, recurring only
  hours       REAL NOT NULL DEFAULT 1,    -- duration, and its weight in the heatmap
  start_at    TEXT,                       -- one-off: ISO start
  from_date   TEXT,                       -- recurring: first date it applies (ISO date)
  to_date     TEXT,                       -- recurring: last date it applies (ISO date)
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Flashcard decks + cards with a light spaced-repetition schedule.
CREATE TABLE IF NOT EXISTS decks (
  id          TEXT PRIMARY KEY,
  course_id   TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lecture_id  TEXT REFERENCES lectures(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual', -- lecture | material | note | cheatsheet | manual
  source_ref  TEXT,                       -- id of the thing it was generated from
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  deck_id     TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  q           TEXT NOT NULL,
  a           TEXT NOT NULL,
  box         INTEGER NOT NULL DEFAULT 0, -- Leitner box: 0..5, drives the interval
  due_at      TEXT,                       -- ISO, null = never reviewed (due now)
  reviews     INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which Notion database each course syncs with, and in which direction.
--
-- One row per (course, kind) pair, so a student can keep a separate Notion
-- destination per paper — which is how people actually organise a semester —
-- rather than everything landing in one app-created table. course_id NULL means
-- "everything not otherwise mapped", so a single shared database still works.
CREATE TABLE IF NOT EXISTS notion_links (
  id          TEXT PRIMARY KEY,
  course_id   TEXT REFERENCES courses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- assessments | notes
  notion_id   TEXT NOT NULL,              -- the Notion database id
  notion_url  TEXT,
  title       TEXT,                       -- what it's called in Notion
  direction   TEXT NOT NULL DEFAULT 'both', -- push | pull | both
  last_push   TEXT,
  last_pull   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Actions ticked off on today's plan, so it stops suggesting them.
-- Keyed by day as well as action: "drill MGMT244 cards" done on Tuesday should be
-- offered again on Wednesday, whereas "read the outline" done once stays done
-- because the underlying gap is closed.
CREATE TABLE IF NOT EXISTS plan_done (
  day     TEXT NOT NULL,               -- local YYYY-MM-DD
  key     TEXT NOT NULL,               -- the action's stable key
  done_at TEXT NOT NULL,
  PRIMARY KEY (day, key)
);

-- One row per weekly digest we've built, so the scheduler never double-sends.
CREATE TABLE IF NOT EXISTS digests (
  id          TEXT PRIMARY KEY,           -- ISO date of the week it covers
  sent_at     TEXT,
  channel     TEXT,                       -- email | local
  subject     TEXT,
  body        TEXT,                       -- markdown, so it's readable in-app
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

`;

/**
 * Indexes, applied AFTER migrations.
 *
 * An index on a column that migrate() is about to add would fail on any database
 * created before that column existed — and the whole schema exec would abort
 * with it, bricking the app for existing users. Keeping them in a second pass
 * makes indexing a migrated column safe.
 */
export const INDEX_SQL = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_course_text_course ON course_text(course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_lectures_course ON lectures(course_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id, week);
CREATE INDEX IF NOT EXISTS idx_assessments_course ON assessments(course_id);
CREATE INDEX IF NOT EXISTS idx_assessments_group ON assessments(group_id);
CREATE INDEX IF NOT EXISTS idx_groups_course ON assessment_groups(course_id);
CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id, due_at);
CREATE INDEX IF NOT EXISTS idx_decks_course ON decks(course_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notion_links_target
  ON notion_links(kind, IFNULL(course_id, ''));
`;
