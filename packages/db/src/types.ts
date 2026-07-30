export type Lms = "moodle" | "blackboard";

export interface Course {
  id: string;
  lms: Lms;
  name: string;
  code: string | null;
  url: string | null;
  color: string | null;
}

export interface Assignment {
  id: string;
  course_id: string | null;
  title: string;
  brief: string | null;
  url: string | null;
  due_at: string | null;
  status: "open" | "submitted" | "graded";
  attachments: string | null; // JSON
}

export interface Lecture {
  id: string;
  course_id: string | null;
  title: string;
  url: string | null;
  media_url: string | null;
  provider: string | null;
  recorded_at: string | null;
  media_path: string | null;
  duration_sec: number | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  id: string;
  lecture_id: string;
  status: "pending" | "downloading" | "transcribing" | "done" | "error";
  text: string | null;
  segments: string | null; // JSON TranscriptSegment[]
  error: string | null;
}

export interface Note {
  id: string;
  course_id: string | null;
  lecture_id: string | null;
  title: string;
  body: string;
}

export interface CalEvent {
  id: string;
  course_id: string | null;
  title: string;
  kind: "deadline" | "open" | "class" | "exam" | "personal" | "other";
  source: "ical" | "assignment" | "manual" | "timetable" | "echo360" | "personal";
  start_at: string;
  end_at: string | null;
  url: string | null;
  location?: string | null;
  notes?: string | null;
}

/** A course file (slides, reading, handout) filed under a course + teaching week. */
export interface Material {
  id: string;
  course_id: string | null;
  week: number | null;
  section: string | null;
  module: string | null;
  title: string;
  kind: "slides" | "reading" | "sheet" | "data" | "other";
  mimetype: string | null;
  source_url: string | null;
  path: string | null;
  bytes: number | null;
  modified_at: string | null;
}

/** A weighted graded item — the input to the grade calculator. */
export interface Assessment {
  id: string;
  course_id: string | null;
  assignment_id: string | null;
  title: string;
  weight: number | null;
  score: number | null;
  max_score: number | null;
  due_at: string | null;
  is_final: number;
  source: "gradebook" | "assignment" | "manual";
}

/** Life outside class — recurring (weekdays + time) or a one-off. */
export interface Commitment {
  id: string;
  title: string;
  kind: "work" | "sport" | "social" | "care" | "travel" | "other";
  weekdays: string | null; // JSON number[] (Sun=0)
  start_time: string | null;
  hours: number;
  start_at: string | null;
  from_date: string | null;
  to_date: string | null;
  notes: string | null;
}

export interface Deck {
  id: string;
  course_id: string | null;
  lecture_id: string | null;
  title: string;
  source: "lecture" | "material" | "note" | "cheatsheet" | "manual";
  source_ref: string | null;
}

export interface Card {
  id: string;
  deck_id: string;
  q: string;
  a: string;
  box: number;
  due_at: string | null;
  reviews: number;
  lapses: number;
}
