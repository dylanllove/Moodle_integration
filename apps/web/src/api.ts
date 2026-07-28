export interface Course {
  id: string;
  lms: string;
  name: string;
  code: string | null;
  url: string | null;
  color: string | null;
  active?: number;
  active_override?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface Assignment {
  id: string;
  course_id: string | null;
  title: string;
  brief: string | null;
  url: string | null;
  due_at: string | null;
  open_at?: string | null;
  status: string;
  attachments: string | null;
}

export interface Lecture {
  id: string;
  course_id: string | null;
  title: string;
  media_path: string | null;
  provider: string | null;
  recorded_at: string | null;
  duration_sec: number | null;
  transcript_status?: string | null;
  has_text?: number;
}

export interface EchoSection {
  sectionId: string;
  courseId: string | null;
  label?: string;
}

export interface Note {
  id: string;
  course_id: string | null;
  lecture_id: string | null;
  title: string;
  body: string;
  updated_at?: string;
}

export interface CalEvent {
  id: string;
  course_id: string | null;
  title: string;
  kind: string;
  source: string;
  start_at: string;
  end_at: string | null;
  url: string | null;
  location?: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set a JSON content-type when there's actually a body — Fastify rejects
  // an empty body when content-type is application/json.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  lecture_id: string;
  status: "pending" | "downloading" | "transcribing" | "done" | "error" | "no_recording";
  text: string | null;
  segments: string | null;
  summary: string | null;
  error: string | null;
}

export const api = {
  health: () => req<{ ok: boolean }>("/health"),
  lecture: (id: string) =>
    req<{ lecture: Lecture; transcript: Transcript | null }>(`/lectures/${id}`),
  transcribe: (id: string) =>
    req<{ ok: boolean; alreadyDone?: boolean; position?: number }>(`/lectures/${id}/transcribe`, {
      method: "POST",
    }),
  transcribeStatus: () =>
    req<{
      queue: { running: string | null; pending: string[] };
      lectures: { lecture_id: string; status: string; error: string | null }[];
    }>("/transcribe/status"),
  settings: () => req<Record<string, string | null>>("/settings"),
  saveSettings: (body: Record<string, string>) =>
    req<{ ok: boolean }>("/settings", { method: "PUT", body: JSON.stringify(body) }),
  courses: (all = false) => req<Course[]>(`/courses${all ? "?all=1" : ""}`),
  setCourseActive: (id: string, active: boolean | null) =>
    req<Course>(`/courses/${id}/active`, { method: "PUT", body: JSON.stringify({ active }) }),
  sync: () => req<{ ok: boolean; error?: string; counts?: Record<string, number> }>("/lms/sync", { method: "POST" }),
  assignments: (courseId?: string) =>
    req<Assignment[]>(`/assignments${courseId ? `?course_id=${courseId}` : ""}`),

  // Reminder lead time
  reminderDays: () => req<{ days: number }>("/settings/reminder-days"),
  setReminderDays: (days: number) =>
    req<{ ok: boolean }>("/settings/reminder-days", { method: "PUT", body: JSON.stringify({ days }) }),

  // Google Calendar
  gcalStatus: () => req<{ configured: boolean; connected: boolean }>("/gcal/status"),
  gcalAuth: () => req<{ url?: string; error?: string }>("/gcal/auth"),
  gcalPush: () => req<{ ok: boolean; pushed?: number; error?: string }>("/gcal/push", { method: "POST" }),
  gcalDisconnect: () => req<{ ok: boolean }>("/gcal/disconnect", { method: "POST" }),

  // Echo360
  echoStatus: () =>
    req<{ connected: boolean; instanceId: string | null; sections: EchoSection[] }>("/echo360/status"),
  echoLogin: () => req<{ ok: boolean; error?: string }>("/echo360/login", { method: "POST" }),
  echoVerify: () => req<{ connected: boolean; error?: string }>("/echo360/verify", { method: "POST" }),
  echoConfig: (body: { instanceId?: string; sections?: EchoSection[] }) =>
    req<{ ok: boolean; sections: EchoSection[] }>("/echo360/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  echoSync: () =>
    req<{
      ok: boolean;
      error?: string;
      counts?: { lessons: number; transcribed: number; noRecording: number; failed: number };
    }>("/echo360/sync", { method: "POST" }),
  lectures: (courseId?: string) =>
    req<Lecture[]>(`/lectures${courseId ? `?course_id=${courseId}` : ""}`),
  events: (from?: string, to?: string) =>
    req<CalEvent[]>(`/events${from && to ? `?from=${from}&to=${to}` : ""}`),

  // Notes
  notes: (q?: { course_id?: string; lecture_id?: string }) => {
    const p = new URLSearchParams(q as Record<string, string>).toString();
    return req<Note[]>(`/notes${p ? `?${p}` : ""}`);
  },
  createNote: (body: Partial<Note>) =>
    req<Note>("/notes", { method: "POST", body: JSON.stringify(body) }),
  updateNote: (id: string, body: Partial<Note>) =>
    req<Note>(`/notes/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteNote: (id: string) => req<{ ok: boolean }>(`/notes/${id}`, { method: "DELETE" }),

  // AI actions
  summariseLecture: (lecture_id: string, mode: "summary" | "notes" = "summary") =>
    req<{ markdown: string }>("/ai/summarise-lecture", {
      method: "POST",
      body: JSON.stringify({ lecture_id, mode }),
    }),
  flashcards: (payload: { text?: string; note_id?: string }) =>
    req<{ cards: { q: string; a: string }[] }>("/ai/flashcards", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  explain: (text: string, context?: string) =>
    req<{ markdown: string }>("/ai/explain", {
      method: "POST",
      body: JSON.stringify({ text, context }),
    }),
  reindex: () => req<{ chunks: number }>("/ai/reindex", { method: "POST" }),
  ask: (question: string, history: { role: string; content: string }[]) =>
    req<{ answer: string }>("/ai/ask", { method: "POST", body: JSON.stringify({ question, history }) }),
  cheatsheet: (course_id: string) =>
    req<{ ok: boolean; note_id: string; markdown: string }>("/ai/cheatsheet", {
      method: "POST",
      body: JSON.stringify({ course_id }),
    }),
  processLecture: (id: string) =>
    req<{ ok: boolean; mode?: string; alreadyDone?: boolean }>(`/lectures/${id}/transcribe`, {
      method: "POST",
    }),
  lectureNotes: (id: string) =>
    req<{ ok: boolean; summary: string | null }>(`/lectures/${id}/notes`, { method: "POST" }),
  outline: (assignment_id: string) =>
    req<{ markdown: string }>("/ai/outline", {
      method: "POST",
      body: JSON.stringify({ assignment_id }),
    }),
  draft: (assignment_id: string, section: string) =>
    req<{ markdown: string }>("/ai/draft", {
      method: "POST",
      body: JSON.stringify({ assignment_id, section }),
    }),
  feedback: (assignment_id: string, draft: string) =>
    req<{ markdown: string }>("/ai/feedback", {
      method: "POST",
      body: JSON.stringify({ assignment_id, draft }),
    }),
};
