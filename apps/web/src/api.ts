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
  notes?: string | null;
}

export interface Material {
  id: string;
  course_id: string | null;
  week: number | null;
  section: string | null;
  module: string | null;
  title: string;
  kind: string;
  mimetype: string | null;
  path: string | null;
  bytes: number | null;
  modified_at: string | null;
  text_len: number | null;
}

export interface MaterialsSyncCounts {
  courses: number;
  found: number;
  downloaded: number;
  skipped: number;
  failed: number;
  root: string;
}

export interface Assessment {
  id: string;
  course_id: string | null;
  assignment_id: string | null;
  group_id: string | null;
  title: string;
  weight: number | null;
  score: number | null;
  max_score: number | null;
  due_at: string | null;
  is_final: number;
  is_bonus: number;
  min_percent: number | null;
  source: string;
}

/** An assessment plus what the calculator worked out about it. */
export interface ResolvedAssessment extends Assessment {
  /** Weight actually applied — a grouped item's share of its group. */
  effectiveWeight: number;
  percent: number | null;
  /** Discarded by its group's drop-lowest rule. */
  dropped: boolean;
  belowHurdle: boolean;
  groupName: string | null;
}

export interface AssessmentGroup {
  id: string;
  course_id: string | null;
  name: string;
  weight: number | null;
  drop_lowest: number;
  items: number;
  counting: number;
  perItemWeight: number;
  scored: number;
}

/** Editable fields on an assessment row. Booleans are 0/1 in the DB. */
export type AssessmentPatch = Omit<Partial<Assessment>, "is_final" | "is_bonus"> & {
  is_final?: boolean;
  is_bonus?: boolean;
};

export interface ParsedOutlineItem {
  title: string;
  weight: number;
  isFinal: boolean;
  isBonus: boolean;
  minPercent: number | null;
  group?: { count: number; dropLowest: number };
}

export interface GradeBand {
  letter: string;
  min: number;
}

export interface BandOutcome {
  letter: string;
  min: number;
  neededAcrossRemaining: number | null;
  neededOnFinal: number | null;
  secured: boolean;
  impossible: boolean;
  /** A hurdle, not the arithmetic, sets the floor for this band. */
  hurdleBinds: boolean;
}

export interface CourseGrades {
  course_id: string;
  code: string | null;
  name: string;
  assessments: ResolvedAssessment[];
  groups: AssessmentGroup[];
  weightTotal: number;
  gradedWeight: number;
  remainingWeight: number;
  earnedPoints: number;
  bonusPoints: number;
  markSoFar: number | null;
  ceiling: number;
  projected: number | null;
  final: { id: string; title: string; weight: number; minPercent: number | null } | null;
  otherRemainingWeight: number;
  assume: number | null;
  bands: BandOutcome[];
  currentLetter: string | null;
  projectedLetter: string | null;
  hurdlesMissed: { title: string; percent: number; required: number }[];
  /** Drops can't be settled until everything's marked, so figures are estimates. */
  dropsProvisional: boolean;
}

export interface WeekLoad {
  weekStart: string;
  weekLabel: string;
  teachingWeek: number | null;
  isCurrent: boolean;
  totalHours: number;
  classHours: number;
  deadlineHours: number;
  personalHours: number;
  byCourse: Record<string, number>;
  drivers: { title: string; course_id: string | null; kind: string; at: string; hours: number }[];
  intensity: number;
  verdict: "unknown" | "quiet" | "steady" | "busy" | "heavy" | "brutal";
}

export interface Workload {
  weeks: WeekLoad[];
  courses: { id: string; code: string | null; name: string }[];
  crunch: WeekLoad[];
  /** The student's typical teaching week, in hours — verdicts are relative to it. */
  baseline: number;
  /** Monday of the last week with published deadlines; later weeks read "unknown". */
  horizon: string | null;
}

export interface Commitment {
  id: string;
  title: string;
  kind: string;
  weekdays: string | null;
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
  source: string;
  created_at: string;
  cards: number;
  due: number;
  mastered: number;
}

export interface ReviewCard {
  id: string;
  deck_id: string;
  q: string;
  a: string;
  box: number;
  due_at: string | null;
  reviews: number;
  lapses: number;
  deck_title: string;
  course_id: string | null;
}

export interface SyncStatus {
  google: {
    configured: boolean;
    connected: boolean;
    lastPush: string | null;
    includeClasses: boolean;
    includePersonal: boolean;
  };
  apple: { webcal: string; https: string; subscribed: boolean };
  notion: {
    configured: boolean;
    connected: boolean;
    databaseUrl: string | null;
    lastPush: string | null;
  };
  autoPush: boolean;
  deadlines: number;
}

export interface DigestStatus {
  enabled: boolean;
  emailConfigured: boolean;
  smtp: { host: string; port: number; user: string; hasPassword: boolean; from: string };
  to: string;
  schedule: { day: number; hour: number; minute: number; label: string };
  lastSlot: string;
  last: {
    id: string;
    sent_at: string | null;
    channel: string;
    subject: string;
    error: string | null;
  } | null;
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

export interface SetupStatus {
  openai: boolean;
  moodle: { connected: boolean; url: string; site?: string; user?: string; error?: string };
  timetable: { url: string; classes: number };
  echo360: boolean;
  deps: { node: string; ffmpeg: boolean };
  materials: number;
  grades: { items: number; weighted: number; targets: number };
  commitments: number;
  decks: number;
  sync: { google: boolean; notion: boolean; apple: boolean };
  digest: boolean;
}

interface MoodleOk {
  ok: boolean;
  site: string;
  user: string;
  url: string;
}

export const api = {
  health: () => req<{ ok: boolean }>("/health"),

  // First-run setup
  setupStatus: () => req<SetupStatus>("/setup/status"),
  setupMoodleLogin: (url: string, username: string, password: string) =>
    req<MoodleOk>("/setup/moodle/login", {
      method: "POST",
      body: JSON.stringify({ url, username, password }),
    }),
  setupMoodleToken: (url: string, token: string) =>
    req<MoodleOk>("/setup/moodle/token", {
      method: "POST",
      body: JSON.stringify({ url, token }),
    }),
  setupOpenai: (key: string) =>
    req<{ ok: boolean }>("/setup/openai", { method: "POST", body: JSON.stringify({ key }) }),
  setupTimetable: (url: string) =>
    req<{ ok: boolean; classes: number }>("/setup/timetable", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
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

  // --- Deadline sync: Google Calendar, Apple (.ics), Notion ---
  syncStatus: () => req<SyncStatus>("/sync/status"),
  syncPush: () =>
    req<{
      ok: boolean;
      google?: { ok: boolean; pushed?: number; removed?: number; error?: string };
      notion?: { ok: boolean; created?: number; updated?: number; archived?: number; error?: string };
    }>("/sync/push", { method: "POST" }),
  syncOptions: (body: { autoPush?: boolean; appleSubscribed?: boolean }) =>
    req<{ ok: boolean }>("/sync/options", { method: "PUT", body: JSON.stringify(body) }),

  gcalStatus: () =>
    req<{
      configured: boolean;
      connected: boolean;
      calendarId: string | null;
      includeClasses: boolean;
      includePersonal: boolean;
      lastPush: string | null;
    }>("/gcal/status"),
  gcalAuth: () => req<{ url?: string; error?: string }>("/gcal/auth"),
  gcalPush: () =>
    req<{ ok: boolean; pushed?: number; removed?: number; error?: string }>("/gcal/push", {
      method: "POST",
    }),
  gcalOptions: (body: { includeClasses?: boolean; includePersonal?: boolean; useOwnCalendar?: boolean }) =>
    req<{ ok: boolean }>("/gcal/options", { method: "PUT", body: JSON.stringify(body) }),
  gcalDisconnect: () => req<{ ok: boolean }>("/gcal/disconnect", { method: "POST" }),

  calendarSubscribe: () =>
    req<{ https: string; webcal: string; kinds: string[]; counts: Record<string, number> }>(
      "/calendar/subscribe",
    ),

  notionConnect: (token: string, page: string) =>
    req<{ ok: boolean; name: string; databaseId: string; url: string; created: boolean }>(
      "/notion/connect",
      { method: "POST", body: JSON.stringify({ token, page }) },
    ),
  notionPush: () =>
    req<{ ok: boolean; created: number; updated: number; archived: number }>("/notion/push", {
      method: "POST",
    }),
  notionDisconnect: () => req<{ ok: boolean }>("/notion/disconnect", { method: "POST" }),

  // --- Course materials (slides & readings, filed by week) ---
  materials: (courseId?: string) =>
    req<{ root: string; materials: Material[] }>(
      `/materials${courseId ? `?course_id=${courseId}` : ""}`,
    ),
  materialsSync: (courseId?: string) =>
    req<{ ok: boolean } & MaterialsSyncCounts>("/materials/sync", {
      method: "POST",
      body: JSON.stringify({ course_id: courseId }),
    }),
  materialText: (id: string) => req<{ title: string; text: string }>(`/materials/${id}/text`),
  materialsReveal: (courseId?: string) =>
    req<{ ok: boolean; dir: string }>("/materials/reveal", {
      method: "POST",
      body: JSON.stringify({ course_id: courseId }),
    }),

  // --- Grades ---
  grades: (courseId?: string) =>
    req<{ bands: GradeBand[]; courses: CourseGrades[]; targets: Record<string, string> }>(
      `/grades${courseId ? `?course_id=${courseId}` : ""}`,
    ),
  gradesSync: (courseId?: string) =>
    req<{ ok: boolean; courses: number; items: number; graded: number; weighted: number }>(
      "/grades/sync",
      { method: "POST", body: JSON.stringify({ course_id: courseId }) },
    ),
  // `is_final` is a boolean on the wire but stored as 0/1, so it's replaced
  // rather than intersected — an intersection would resolve to `never`.
  createAssessment: (body: AssessmentPatch & { course_id: string }) =>
    req<Assessment>("/assessments", { method: "POST", body: JSON.stringify(body) }),
  updateAssessment: (id: string, body: AssessmentPatch) =>
    req<Assessment>(`/assessments/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAssessment: (id: string) => req<{ ok: boolean }>(`/assessments/${id}`, { method: "DELETE" }),
  setGradeTarget: (course_id: string, letter: string | null) =>
    req<{ ok: boolean }>("/grades/target", { method: "PUT", body: JSON.stringify({ course_id, letter }) }),
  setGradeAssume: (course_id: string, assume: number | null) =>
    req<{ ok: boolean }>("/grades/assume", { method: "PUT", body: JSON.stringify({ course_id, assume }) }),
  // Weighted bundles — "Labs 20% total, best 8 of 10"
  createGroup: (body: {
    course_id: string;
    name: string;
    weight?: number | null;
    drop_lowest?: number;
    count?: number;
  }) => req<AssessmentGroup>("/assessment-groups", { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (
    id: string,
    body: { name?: string; weight?: number | null; drop_lowest?: number },
  ) => req<AssessmentGroup>(`/assessment-groups/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteGroup: (id: string, alsoItems = false) =>
    req<{ ok: boolean }>(`/assessment-groups/${id}${alsoItems ? "?items=delete" : ""}`, {
      method: "DELETE",
    }),
  addGroupItem: (id: string) =>
    req<Assessment>(`/assessment-groups/${id}/items`, { method: "POST" }),

  // Bulk weight entry
  normaliseWeights: (course_id: string) =>
    req<{ ok: boolean; scaled: number; from: number }>("/grades/normalise", {
      method: "POST",
      body: JSON.stringify({ course_id }),
    }),
  parseOutline: (text: string) =>
    req<{ items: ParsedOutlineItem[]; total: number; skipped: string[] }>("/grades/parse-outline", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  importOutline: (course_id: string, items: ParsedOutlineItem[], replace: boolean) =>
    req<{ ok: boolean; created: number; groups: number }>("/grades/import-outline", {
      method: "POST",
      body: JSON.stringify({ course_id, items, replace }),
    }),

  gradeBands: () => req<{ bands: GradeBand[]; defaults: GradeBand[] }>("/grades/bands"),
  setGradeBands: (bands: GradeBand[]) =>
    req<{ ok: boolean; bands: GradeBand[] }>("/grades/bands", {
      method: "PUT",
      body: JSON.stringify({ bands }),
    }),

  // --- Workload & life ---
  workload: (weeks = 14) => req<Workload>(`/workload?weeks=${weeks}`),
  commitments: () => req<Commitment[]>("/commitments"),
  createCommitment: (body: {
    title: string;
    kind?: string;
    weekdays?: number[] | null;
    start_time?: string | null;
    hours?: number;
    start_at?: string | null;
    from_date?: string | null;
    to_date?: string | null;
    notes?: string | null;
  }) => req<Commitment>("/commitments", { method: "POST", body: JSON.stringify(body) }),
  deleteCommitment: (id: string) => req<{ ok: boolean }>(`/commitments/${id}`, { method: "DELETE" }),

  // --- Flashcards ---
  decks: (courseId?: string) =>
    req<{ decks: Deck[] }>(`/decks${courseId ? `?course_id=${courseId}` : ""}`),
  deck: (id: string) =>
    req<{ deck: Deck; cards: { id: string; q: string; a: string; box: number; due_at: string | null }[] }>(
      `/decks/${id}`,
    ),
  generateDeck: (type: "lecture" | "material" | "note" | "course", id: string, count?: number) =>
    req<{ ok: boolean; id: string; cards: number; title: string }>("/decks/generate", {
      method: "POST",
      body: JSON.stringify({ type, id, count }),
    }),
  deleteDeck: (id: string) => req<{ ok: boolean }>(`/decks/${id}`, { method: "DELETE" }),
  reviewQueue: (q: { deck_id?: string; course_id?: string; limit?: number } = {}) => {
    const p = new URLSearchParams(
      Object.entries(q).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return req<{ cards: ReviewCard[]; total: number }>(`/review/queue${p ? `?${p}` : ""}`);
  },
  review: (id: string, got: boolean) =>
    req<{ ok: boolean; box: number; due_at: string }>(`/review/${id}`, {
      method: "POST",
      body: JSON.stringify({ got }),
    }),
  quizletText: (id: string) => req<{ text: string; cards: number }>(`/decks/${id}/quizlet`),

  // --- Weekly digest ---
  digestStatus: () => req<DigestStatus>("/digest/status"),
  digestPreview: () => req<{ subject: string; markdown: string }>("/digest/preview"),
  digestHistory: () =>
    req<{ id: string; sent_at: string | null; channel: string; subject: string; body: string; error: string | null }[]>(
      "/digest/history",
    ),
  digestSend: () =>
    req<{ ok: boolean; sent: boolean; channel: string; error?: string }>("/digest/send", {
      method: "POST",
    }),
  digestTest: () => req<{ ok: boolean; to: string }>("/digest/test", { method: "POST" }),
  digestSettings: (body: {
    enabled?: boolean;
    to?: string;
    day?: number;
    hour?: number;
    minute?: number;
    smtp?: { host?: string; port?: number; user?: string; pass?: string; from?: string };
  }) => req<{ ok: boolean }>("/digest/settings", { method: "PUT", body: JSON.stringify(body) }),

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
