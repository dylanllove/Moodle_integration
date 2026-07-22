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
CREATE INDEX IF NOT EXISTS idx_course_text_course ON course_text(course_id);

CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_lectures_course ON lectures(course_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_type, source_id);
`;
