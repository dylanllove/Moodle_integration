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
  kind: "deadline" | "class" | "exam" | "other";
  source: "ical" | "assignment" | "manual";
  start_at: string;
  end_at: string | null;
  url: string | null;
}
