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
  /** Pull this course's slides and readings down. */
  sync_materials?: number;
  /** Pull and transcribe its recordings. */
  sync_lectures?: number;
  excluded?: number;
  /** What it's currently costing, so removing it is an informed choice. */
  files?: number;
  bytes?: number;
  lectures?: number;
  transcribed?: number;
  cards?: number;
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
  /** A study-notes summary has been written for it. */
  has_notes?: number;
  /** When the transcript last changed — how "new" the material is. */
  transcript_at?: string | null;
}

export interface EchoSection {
  sectionId: string;
  courseId: string | null;
  label?: string;
}

export interface DiscoveredSection {
  sectionId: string;
  courseId: string | null;
  courseCode: string | null;
  label: string;
  via: "lti" | "enrollments";
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
  /** Available today — reviews plus this course's share of the new-card intake. */
  due: number;
  mastered: number;
  /** Never shown. These arrive at the daily rate rather than all at once. */
  unseen: number;
}

export interface CourseIntake {
  courseId: string | null;
  allowance: number;
  introducedToday: number;
  remaining: number;
  unseen: number;
  daysToNext: number | null;
  behind: boolean;
  reason: string;
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
  auto: AutoSync;
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

/** A hit from the one search box — see the server's search.ts for the shape. */
export interface SearchHit {
  id: string;
  group:
    | "course"
    | "deadline"
    | "class"
    | "assignment"
    | "lecture"
    | "material"
    | "note"
    | "deck"
    | "content";
  title: string;
  subtitle: string | null;
  badge: string | null;
  to: string | null;
  href: string | null;
  snippet: string | null;
  score: number;
}

/** Where an answer came from, so it can be opened and checked. */
export interface AnswerSource {
  label: string;
  kind: "note" | "lecture" | "material" | "course-page";
  courseId: string | null;
  courseCode: string | null;
  to: string | null;
  href: string | null;
}

export interface SyncPhase {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "error";
  detail: string | null;
}

/* --- AI cost --------------------------------------------------------------- */

export interface AiStatus {
  health: AiHealth;
  spend: {
    monthUsd: number;
    todayUsd: number;
    budgetUsd: number | null;
    overBudget: boolean;
    byTask: { task: string; provider: string; calls: number; usd: number }[];
  };
  cache: { entries: number; savedUsd: number };
  provider: string;
  transcribeProvider: string;
  cleanTranscripts: boolean;
  budgetUsd: number | null;
  local: {
    text: { ok: boolean; models: string[]; url: string };
    audio: { ok: boolean; engine?: string; model?: string | null };
  };
}

/* --- Today's plan ---------------------------------------------------------- */

export type ActionKind = "deadline" | "exam-prep" | "review" | "study-lecture" | "setup-gap";

export interface PlanAction {
  key: string;
  kind: ActionKind;
  title: string;
  why: string;
  courseId: string | null;
  courseCode: string | null;
  minutes: number;
  to: string;
  priority: number;
  done: boolean;
}

export interface CourseReadiness {
  courseId: string;
  courseCode: string | null;
  daysToNext: number | null;
  nextTitle: string | null;
  seen: number;
  strong: number;
  cards: number;
  weightsKnown: boolean;
  verdict: "not started" | "behind" | "getting there" | "on top of it" | "nothing due";
}

export interface StudyPlan {
  date: string;
  actions: PlanAction[];
  readiness: CourseReadiness[];
  minutes: number;
  committedHours: number;
  headline: string;
}

/* --- Notion ---------------------------------------------------------------- */

export type NotionLinkKind = "assessments" | "notes";
export type NotionDirection = "push" | "pull" | "both";

export interface NotionTarget {
  id: string;
  object: "page" | "database";
  title: string;
  url: string;
  parent: string;
  shape: "assessments" | "notes" | "unknown";
  properties: Record<string, string>;
}

export interface NotionLink {
  id: string;
  course_id: string | null;
  kind: NotionLinkKind;
  notion_id: string;
  notion_url: string | null;
  title: string | null;
  direction: NotionDirection;
  last_push: string | null;
  last_pull: string | null;
}

export interface NotionSuggestion {
  course_id: string | null;
  courseCode: string | null;
  kind: NotionLinkKind;
  notion_id: string;
  title: string;
  url: string;
  because: string;
}

export interface NotionStatus {
  configured: boolean;
  connected: boolean;
  parentPage: string | null;
  links: NotionLink[];
  courses: { id: string; code: string | null; name: string }[];
}

export interface NotionSyncResult {
  ok: boolean;
  created: number;
  updated: number;
  archived: number;
  pulled: number;
  skipped: number;
  perLink: {
    title: string | null;
    kind: string;
    courseCode: string | null;
    counts: { created: number; updated: number; archived: number; pulled: number; skipped: number };
  }[];
}

export interface AutoSync {
  enabled: boolean;
  minutes: number;
  nextAt: string | null;
}

export interface AiHealth {
  ok: boolean;
  fault: "quota" | "auth" | "rate-limit" | "network" | "other" | null;
  message: string | null;
  at: string | null;
}

export interface SyncProgress {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phases: SyncPhase[];
  error: string | null;
  auto?: AutoSync;
  ai?: AiHealth;
}

/**
 * Stream an answer token-by-token. Reads the SSE frames the ask route writes;
 * `onDelta` fires per fragment and `onSources` once, up front.
 */
async function askStream(
  question: string,
  history: { role: string; content: string }[],
  handlers: {
    onSources?: (s: AnswerSource[]) => void;
    onDelta: (text: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const res = await fetch("/api/ai/ask/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, history }),
    signal: handlers.signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim()) as
        | { type: "sources"; sources: AnswerSource[] }
        | { type: "delta"; text: string }
        | { type: "done" }
        | { type: "error"; message: string };
      if (event.type === "sources") handlers.onSources?.(event.sources);
      else if (event.type === "delta") handlers.onDelta(event.text);
      else if (event.type === "error") throw new Error(event.message);
    }
  }
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
  setupMoodleFind: (query: string) =>
    req<{
      ok: boolean;
      domain: string | null;
      advice: string | null;
      sites: { url: string; name: string | null; webServices: boolean; note: string | null }[];
    }>("/setup/moodle/find", { method: "POST", body: JSON.stringify({ query }) }),
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
  setCourseSync: (id: string, body: { materials?: boolean; lectures?: boolean }) =>
    req<Course>(`/courses/${encodeURIComponent(id)}/sync`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteCourse: (id: string) =>
    req<{ ok: boolean; course: string; filesRemoved: number; lecturesRemoved: number }>(
      `/courses/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  restoreCourse: (id: string) =>
    req<{ ok: boolean }>(`/courses/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  excludedCourses: () =>
    req<{ id: string; code: string | null; name: string }[]>("/courses/excluded"),
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
  syncOptions: (body: {
    autoPush?: boolean;
    appleSubscribed?: boolean;
    autoSyncEnabled?: boolean;
    autoSyncMinutes?: number;
  }) => req<{ ok: boolean; auto: AutoSync }>("/sync/options", { method: "PUT", body: JSON.stringify(body) }),

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

  // --- AI cost & providers ---
  aiStatus: () => req<AiStatus>("/ai/status"),
  aiOptions: (body: {
    provider?: string;
    transcribeProvider?: string;
    budgetUsd?: number | null;
    cleanTranscripts?: boolean;
  }) => req<{ ok: boolean }>("/ai/options", { method: "PUT", body: JSON.stringify(body) }),
  aiProbeLocal: () => req<{ ok: boolean }>("/ai/probe-local", { method: "POST" }),
  aiClearCache: () => req<{ ok: boolean; cleared: number }>("/ai/cache/clear", { method: "POST" }),

  // --- Today's plan ---
  plan: () => req<StudyPlan>("/plan"),
  planDone: (key: string, done: boolean) =>
    req<StudyPlan>("/plan/done", { method: "POST", body: JSON.stringify({ key, done }) }),

  // --- Notion (two-way, one database per course if you like) ---
  notionStatus: () => req<NotionStatus>("/notion/status"),
  notionToken: (token: string) =>
    req<{ ok: boolean; name: string; pages: NotionTarget[]; databases: NotionTarget[] }>(
      "/notion/token",
      { method: "POST", body: JSON.stringify({ token }) },
    ),
  notionInventory: () =>
    req<{ ok: boolean; name: string; pages: NotionTarget[]; databases: NotionTarget[] }>(
      "/notion/inventory",
    ),
  notionSuggest: () =>
    req<{ ok: boolean; suggestions: NotionSuggestion[]; unmatched: string[] }>("/notion/suggest"),
  notionSetParent: (page: string) =>
    req<{ ok: boolean; parentPage: string }>("/notion/parent", {
      method: "PUT",
      body: JSON.stringify({ page }),
    }),
  notionLink: (body: {
    course_id: string | null;
    kind: NotionLinkKind;
    notion: string;
    direction?: NotionDirection;
  }) =>
    req<{ ok: boolean; link: NotionLink; fields: Record<string, string | null> }>("/notion/links", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  notionCreateDatabase: (body: { course_id: string | null; kind: NotionLinkKind; title?: string }) =>
    req<{ ok: boolean; link: NotionLink; created: boolean }>("/notion/databases", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  notionUnlink: (id: string) =>
    req<{ ok: boolean; links: NotionLink[] }>(`/notion/links/${id}`, { method: "DELETE" }),
  notionSync: () => req<NotionSyncResult>("/notion/sync", { method: "POST" }),
  notionSchema: (id: string) =>
    req<{ ok: boolean; title: string; object: string; shape: string; fields: Record<string, string | null> }>(
      `/notion/schema?id=${encodeURIComponent(id)}`,
    ),

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
    req<{ decks: Deck[]; intake: CourseIntake | null; intakeByCourse: CourseIntake[] }>(
      `/decks${courseId ? `?course_id=${courseId}` : ""}`,
    ),
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
    req<{
      connected: boolean;
      instanceId: string | null;
      sections: EchoSection[];
      session: { failures: number; wobbly: boolean; lastWarm: string | null };
    }>("/echo360/status"),
  echoKeepalive: () =>
    req<{ ok: boolean; reason?: string }>("/echo360/keepalive", { method: "POST" }),
  echoLogin: () => req<{ ok: boolean; error?: string }>("/echo360/login", { method: "POST" }),
  echoVerify: () => req<{ connected: boolean; error?: string }>("/echo360/verify", { method: "POST" }),
  echoConfig: (body: { instanceId?: string; sections?: EchoSection[] }) =>
    req<{ ok: boolean; sections: EchoSection[] }>("/echo360/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  echoDiscover: () =>
    req<{
      ok: boolean;
      error?: string;
      expired?: boolean;
      changed?: number;
      found?: DiscoveredSection[];
      notes?: string[];
      sections?: EchoSection[];
    }>("/echo360/discover", { method: "POST", body: JSON.stringify({ apply: true }) }),
  echoSync: () =>
    req<{
      ok: boolean;
      error?: string;
      expired?: boolean;
      counts?: {
        lessons: number;
        sections: number;
        failed: number;
        attempted: number;
        transcribed: number;
        stillWaiting: number;
        deferred: number;
        noted: number;
      };
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
    req<{ answer: string; sources: AnswerSource[] }>("/ai/ask", {
      method: "POST",
      body: JSON.stringify({ question, history }),
    }),
  askStream,
  search: (q: string, signal?: AbortSignal) =>
    req<{ q: string; hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`, { signal }),
  syncRun: () =>
    req<{ ok: boolean; alreadyRunning: boolean; state: SyncProgress }>("/sync/run", {
      method: "POST",
    }),
  syncProgress: () => req<SyncProgress>("/sync/progress"),
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
