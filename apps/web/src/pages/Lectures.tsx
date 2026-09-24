import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  type Anchor,
  type Course,
  type Lecture,
  type LectureDetail as Detail,
  type TranscriptSegment,
} from "../api.js";
import { useSyncedRefresh } from "../hooks.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  Tabs,
  Select,
  Notice,
  EmptyState,
  Loading,
  Spinner,
} from "../ui.js";
import { Markdown } from "../Markdown.js";
import { courseColor } from "../colors.js";

export function Lectures() {
  // ?lecture= opens one directly (search, or a citation on an answer);
  // ?course= narrows the list to one course's recordings.
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const wanted = params.get("lecture");
  const onlyCourse = params.get("course");
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selected, setSelected] = useState<string | null>(wanted);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([api.lectures(), api.courses()]);
    setLectures(l);
    setCourses(c);
    setSelected((cur) => cur ?? l.find((x) => x.has_text)?.id ?? l[0]?.id ?? null);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useSyncedRefresh(load);

  // A later deep link must win over whatever was already open.
  useEffect(() => {
    if (wanted) setSelected(wanted);
  }, [wanted]);

  // Group lectures under their (active) course.
  const groups = useMemo(() => {
    const byCourse = new Map<string, { course: Course | null; items: Lecture[] }>();
    for (const l of lectures) {
      if (onlyCourse && l.course_id !== onlyCourse) continue;
      const key = l.course_id ?? "none";
      const course = courses.find((c) => c.id === l.course_id) ?? null;
      const g = byCourse.get(key) ?? { course, items: [] };
      g.items.push(l);
      byCourse.set(key, g);
    }
    return [...byCourse.values()].sort((a, b) => (a.course?.code ?? "").localeCompare(b.course?.code ?? ""));
  }, [lectures, courses, onlyCourse]);

  // Count what's actually on screen, so a course-scoped view doesn't claim
  // credit for the whole semester.
  const shown = groups.flatMap((g) => g.items);
  const total = shown.length;
  const done = shown.filter((l) => l.has_text).length;

  return (
    <div>
      <PageHeader
        title="Lectures & transcripts"
        subtitle={total ? `${done} of ${total} transcribed across ${groups.length} course${groups.length > 1 ? "s" : ""}` : "Your current courses' lectures"}
        actions={
          <>
            {/* Arriving scoped from search shouldn't feel like the rest vanished. */}
            {onlyCourse && (
              <Button onClick={() => navigate("/lectures", { replace: true })}>
                Show all courses
              </Button>
            )}
            <UploadButton courses={courses} onDone={load} />
          </>
        }
      />
      {loading && <Loading label="Loading lectures…" />}
      <div className={`grid grid-cols-1 gap-6 lg:grid-cols-[22rem_1fr] ${loading ? "hidden" : ""}`}>
        <div className="space-y-6">
          {groups.length === 0 ? (
            <EmptyState icon="🎧">No lectures yet — connect Echo360 or upload a recording.</EmptyState>
          ) : (
            groups.map((g) => {
              const gid = g.course?.id ?? "none";
              const gdone = g.items.filter((l) => l.has_text).length;
              return (
                <div key={gid}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <span
                      className="h-2 w-2 rounded-pill"
                      style={{ background: courseColor(g.course?.id ?? null) }}
                    />
                    <span className="font-display text-[13px] font-bold tracking-tight text-ink">
                      {g.course?.code ?? "Other"}
                    </span>
                    <span className="text-xs text-ink-muted">{gdone}/{g.items.length} transcribed</span>
                  </div>
                  <div className="space-y-0.5">
                    {g.items.map((l) => {
                      const active = selected === l.id;
                      return (
                        <button
                          key={l.id}
                          onClick={() => setSelected(l.id)}
                          aria-current={active}
                          className={`flex w-full items-center gap-2 rounded-field px-3.5 py-2.5 text-left transition duration-200 ${
                            active ? "bg-accent-tint" : "hover:bg-chip"
                          }`}
                        >
                          <span
                            className={`min-w-0 flex-1 truncate text-sm ${
                              active ? "font-semibold text-accent-deep" : "text-ink"
                            }`}
                          >
                            {l.title}
                          </span>
                          <StatusDot l={l} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div>
          {selected ? (
            <LectureDetail
              id={selected}
              // A citation ("Lecture 4 · 14:37") opens the lecture at that moment.
              at={selected === wanted && params.get("t") ? Number(params.get("t")) : null}
              onChange={load}
            />
          ) : (
            <EmptyState icon="📄">Select a lecture.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Only the exceptions get a badge. Most lectures are transcribed, so badging
 * that case makes the common state as loud as the ones needing attention —
 * the group header already carries the "8/10 transcribed" count.
 */
function StatusDot({ l }: { l: Lecture }) {
  if (l.has_text) return null;
  // A class that hasn't happened yet isn't waiting on us, and a bare dash reads
  // like something went wrong. Say what it actually is.
  if (l.recorded_at && new Date(l.recorded_at).getTime() > Date.now()) {
    return <span className="text-xs text-ink-muted">upcoming</span>;
  }
  if (l.transcript_status === "no_recording") return <Badge tone="amber">no rec</Badge>;
  if (l.transcript_status === "needs_local") return <Badge tone="amber">needs model</Badge>;
  if (l.transcript_status === "over_budget") return <Badge tone="amber">over budget</Badge>;
  if (["pending", "downloading", "transcribing"].includes(l.transcript_status ?? "")) {
    return <Badge tone="neutral">working…</Badge>;
  }
  return <span className="text-xs text-ink-muted/50">—</span>;
}

function UploadButton({ courses, onDone }: { courses: Course[]; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [course, setCourse] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("course_id", course || courses[0]?.id || "");
      fd.append("title", file.name.replace(/\.[^.]+$/, ""));
      fd.append("file", file);
      const res = await fetch("/api/lectures/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).error);
      onDone();
    } catch (e) {
      setErr(`Upload failed — ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {/* Only worth asking when there's an actual choice to make. */}
        {courses.length > 1 && (
          <div className="w-32">
            <Select
              value={course}
              onChange={(e) => setCourse(e.target.value)}
              aria-label="Course for upload"
            >
              <option value="">Course…</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>{c.code}</option>
              ))}
            </Select>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
        <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Transcribing…" : "Upload recording"}
        </Button>
      </div>
      {err && <Notice tone="error" className="max-w-sm">{err}</Notice>}
    </div>
  );
}

const SETTLED = ["done", "error", "no_recording", "needs_local", "over_budget"];

function LectureDetail({ id, at, onChange }: { id: string; at: number | null; onChange: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"notes" | "transcript" | "timestamps">("notes");
  const [notesBusy, setNotesBusy] = useState(false);
  /** The moment to scroll the timestamps to, after a jump. */
  const [focus, setFocus] = useState<number | null>(at);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadOne() {
    const d = await api.lecture(id);
    setDetail(d);
    return d.transcript?.status;
  }

  async function makeNotes() {
    setNotesBusy(true);
    try {
      await api.lectureNotes(id);
      await loadOne();
      setTab("notes");
    } finally {
      setNotesBusy(false);
    }
  }
  useEffect(() => {
    setFocus(at);
    loadOne().then((s) => setTab(at != null ? "timestamps" : s === "done" ? "notes" : "transcript"));
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [id, at]);

  async function process() {
    await api.processLecture(id);
    await loadOne();
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await loadOne();
      if (SETTLED.includes(s ?? "")) {
        clearInterval(poll.current!);
        onChange();
      }
    }, 2500);
  }

  if (!detail) return null;
  const { lecture, transcript, digest } = detail;
  const status = transcript?.status;
  const busy = ["pending", "downloading", "transcribing"].includes(status ?? "");
  const noRecording = status === "no_recording";
  const waiting = status === "needs_local" || status === "over_budget";
  const segments: TranscriptSegment[] = transcript?.segments ? JSON.parse(transcript.segments) : [];
  const isSlides = lecture.provider === "slides";
  const done = status === "done" && !!transcript?.text;
  const paragraphs = (transcript?.clean_text ?? transcript?.text ?? "").split(/\n{2,}/).filter((p) => p.trim());
  const hasNotes = !!digest || !!transcript?.summary;
  const effectiveTab = tab === "timestamps" && segments.length === 0 ? "transcript" : tab;
  const anchor: Anchor = digest?.anchor ?? (isSlides ? "page" : "seconds");

  const jump = (sec: number | null) => {
    if (sec == null || !segments.length) return;
    setFocus(sec);
    setTab("timestamps");
  };

  const tabs = [
    { key: "notes" as const, label: "Study notes" },
    { key: "transcript" as const, label: "Transcript" },
    ...(segments.length ? [{ key: "timestamps" as const, label: isSlides ? "Slides" : "Timestamps" }] : []),
  ];

  return (
    <Card className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[22px] font-bold leading-snug tracking-tight text-ink">
            {lecture.title}
          </h2>
          {/* Provider only when it's the unusual one; "transcribed" is implied
              by the notes/transcript tabs being there at all. */}
          {(isSlides || noRecording || digest?.week) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {digest?.week && <Chip>week {digest.week}</Chip>}
              {isSlides && <Chip>slides</Chip>}
              {noRecording && <Badge tone="amber">no recording yet</Badge>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {done && (
            <a href={`/api/export/lecture/${encodeURIComponent(id)}`} download>
              <Button size="sm">Download .md</Button>
            </a>
          )}
          <Button size="sm" variant="primary" disabled={busy} onClick={process}>
            {busy ? "Working…" : done ? "Re-process" : isSlides ? "Extract text" : "Transcribe"}
          </Button>
        </div>
      </div>

      {busy && <Spinner label={status === "transcribing" ? "Transcribing & writing notes…" : "Downloading…"} />}
      {status === "error" && <Notice tone="error">{transcript?.error}</Notice>}
      {waiting && (
        <Notice tone="warn">
          {transcript?.error ??
            (status === "needs_local"
              ? "Waiting for the local transcription model — install it in Settings → AI."
              : "Transcribing this would go over the monthly AI budget.")}{" "}
          <a className="font-semibold underline" href="/settings">
            Open Settings
          </a>
        </Notice>
      )}

      {done && (
        <>
          <div className="mb-4">
            <Tabs tabs={tabs} value={effectiveTab} onChange={setTab} />
          </div>

          {effectiveTab === "notes" &&
            (digest ? (
              <StructuredNotes detail={detail} anchor={anchor} onJump={segments.length ? jump : null} />
            ) : hasNotes ? (
              <div className="pane max-h-[64vh] rounded-card bg-chip/50 p-5">
                <Markdown>{transcript!.summary!}</Markdown>
              </div>
            ) : (
              <div className="rounded-card border border-dashed border-hair p-10 text-center">
                <p className="mb-4 text-sm text-ink-muted">Turn this lecture into quick study notes.</p>
                <Button variant="primary" disabled={notesBusy} onClick={makeNotes}>
                  {notesBusy ? "Writing notes…" : "Generate study notes"}
                </Button>
              </div>
            ))}

          {effectiveTab === "transcript" && (
            <div className="pane max-h-[64vh] space-y-3.5 rounded-card bg-chip/50 p-5 text-[15px] leading-7 text-ink-soft">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}

          {effectiveTab === "timestamps" && <Timeline segments={segments} focus={focus} isSlides={isSlides} />}
        </>
      )}

      {noRecording && (
        <p className="text-sm text-ink-muted">
          {transcript?.error
            ? `${transcript.error} It'll be checked again automatically.`
            : "This class hasn't been recorded/published yet. It'll transcribe automatically once the recording appears."}
        </p>
      )}
      {!busy && !done && !noRecording && !waiting && (
        <p className="text-sm text-ink-muted">
          Not processed yet — click {isSlides ? "Extract text" : "Transcribe"}.
        </p>
      )}
    </Card>
  );
}

/** A clickable "14:37" / "slide 6" that jumps to that point in the transcript. */
function At({ sec, anchor, onJump }: { sec: number | null; anchor: Anchor; onJump: ((s: number) => void) | null }) {
  if (sec == null || anchor === "none") return null;
  const label = anchor === "page" ? `slide ${sec}` : fmt(sec);
  if (!onJump) {
    return <span className="mt-1 shrink-0 self-start font-mono text-[11px] leading-4 tabular-nums text-ink-muted">{label}</span>;
  }
  return (
    <button
      onClick={() => onJump(sec)}
      className="mt-1 shrink-0 self-start rounded-field bg-surface px-1.5 py-0.5 font-mono text-[11px] leading-4 tabular-nums text-accent-deep transition hover:bg-accent-tint"
      title="Jump to this point"
    >
      {label}
    </button>
  );
}

function StructuredNotes({
  detail,
  anchor,
  onJump,
}: {
  detail: Detail;
  anchor: Anchor;
  onJump: ((s: number) => void) | null;
}) {
  const { digest, sections, concepts, emphasis, questions } = detail;
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const bySection = useMemo(() => {
    const m = new Map<string | null, typeof concepts>();
    for (const c of concepts) m.set(c.section_id, [...(m.get(c.section_id) ?? []), c]);
    return m;
  }, [concepts]);
  const terms = concepts.filter((c) => c.kind !== "concept");
  const H = ({ children }: { children: string }) => (
    <h3 className="mb-2 mt-6 font-display text-[15px] font-bold tracking-tight text-ink first:mt-0">{children}</h3>
  );

  return (
    <div className="pane max-h-[64vh] rounded-card bg-chip/50 p-5 text-[15px] leading-7 text-ink-soft">
      <H>TL;DR</H>
      <p>{digest!.tldr}</p>
      {digest!.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {digest!.topics.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      )}

      {emphasis.length > 0 && (
        <>
          <H>⭐ Likely exam / emphasis</H>
          <ul className="space-y-2">
            {emphasis.map((e) => (
              <li key={e.id} className="flex gap-2">
                <At sec={e.start_sec} anchor={anchor} onJump={onJump} />
                <span>
                  “{e.quote}” — <span className="text-ink-muted">{e.why}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {sections.length > 0 && <H>Walkthrough</H>}
      <div className="space-y-4">
        {sections.map((s) => (
          <div key={s.id}>
            <div className="flex items-baseline gap-2">
              <At sec={s.start_sec} anchor={anchor} onJump={onJump} />
              <span className="font-semibold text-ink">{s.title}</span>
            </div>
            <p className="mt-1">{s.summary}</p>
            {(bySection.get(s.id) ?? [])
              .filter((c) => c.kind === "concept")
              .map((c) => (
                <p key={c.id} className="mt-1 pl-3">
                  <strong className="text-ink">{c.name}</strong> — {c.explanation}
                </p>
              ))}
          </div>
        ))}
      </div>

      {terms.length > 0 && (
        <>
          <H>Key terms</H>
          <ul className="space-y-1.5">
            {terms.map((c) => (
              <li key={c.id} className="flex gap-2">
                <At sec={c.start_sec} anchor={anchor} onJump={onJump} />
                <span>
                  <strong className="text-ink">{c.name}</strong> — {c.explanation}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {questions.length > 0 && (
        <>
          <H>Test yourself</H>
          <ul className="space-y-2">
            {questions.map((q) => (
              <li key={q.id}>
                <button
                  className="text-left"
                  onClick={() =>
                    setReveal((r) => {
                      const n = new Set(r);
                      n.has(q.id) ? n.delete(q.id) : n.add(q.id);
                      return n;
                    })
                  }
                >
                  {q.question}
                </button>
                {reveal.has(q.id) && (
                  <p className="mt-1 flex gap-2 pl-3 text-ink-muted">
                    <span>{q.answer}</span>
                    <At sec={q.start_sec} anchor={anchor} onJump={onJump} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Timeline({
  segments,
  focus,
  isSlides,
}: {
  segments: TranscriptSegment[];
  focus: number | null;
  isSlides: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pos = (s: TranscriptSegment) => (isSlides ? (s.page ?? 0) : s.start);
  // The segment containing the focused moment: the last one starting at or before it.
  const target = useMemo(() => {
    if (focus == null) return -1;
    let hit = -1;
    segments.forEach((s, i) => {
      if (pos(s) <= focus) hit = i;
    });
    return hit;
  }, [segments, focus, isSlides]);
  useEffect(() => {
    if (target < 0) return;
    box.current?.querySelector(`[data-seg="${target}"]`)?.scrollIntoView({ block: "center" });
  }, [target]);

  return (
    <div ref={box} className="pane max-h-[64vh] rounded-card bg-chip/50 p-4 text-sm leading-relaxed text-ink-soft">
      {segments.map((s, i) => (
        <p
          key={i}
          data-seg={i}
          className={`flex gap-3 rounded-field px-2 py-1 transition duration-150 hover:bg-surface ${
            i === target ? "bg-accent-tint" : ""
          }`}
        >
          <span className="shrink-0 select-none pt-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {isSlides ? `slide ${s.page ?? i + 1}` : fmt(s.start)}
          </span>
          <span>{s.text}</span>
        </p>
      ))}
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
