import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lecture, type Transcript, type TranscriptSegment, type Course } from "../api.js";
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
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [l, c] = await Promise.all([api.lectures(), api.courses()]);
    setLectures(l);
    setCourses(c);
    setSelected((cur) => cur ?? l.find((x) => x.has_text)?.id ?? l[0]?.id ?? null);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  // Group lectures under their (active) course.
  const groups = useMemo(() => {
    const byCourse = new Map<string, { course: Course | null; items: Lecture[] }>();
    for (const l of lectures) {
      const key = l.course_id ?? "none";
      const course = courses.find((c) => c.id === l.course_id) ?? null;
      const g = byCourse.get(key) ?? { course, items: [] };
      g.items.push(l);
      byCourse.set(key, g);
    }
    return [...byCourse.values()].sort((a, b) => (a.course?.code ?? "").localeCompare(b.course?.code ?? ""));
  }, [lectures, courses]);

  const total = lectures.length;
  const done = lectures.filter((l) => l.has_text).length;

  return (
    <div>
      <PageHeader
        title="Lectures & transcripts"
        subtitle={total ? `${done} of ${total} transcribed across ${groups.length} course${groups.length > 1 ? "s" : ""}` : "Your current courses' lectures"}
        actions={<UploadButton courses={courses} onDone={load} />}
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
          {selected ? <LectureDetail id={selected} onChange={load} /> : <EmptyState icon="📄">Select a lecture.</EmptyState>}
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
  if (l.transcript_status === "no_recording") return <Badge tone="amber">no rec</Badge>;
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

function LectureDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [tab, setTab] = useState<"notes" | "transcript" | "timestamps">("notes");
  const [notesBusy, setNotesBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadOne() {
    const { lecture, transcript } = await api.lecture(id);
    setLecture(lecture);
    setTranscript(transcript);
    return transcript?.status;
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
    loadOne().then((s) => setTab(s === "done" ? "notes" : "transcript"));
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [id]);

  async function process() {
    await api.processLecture(id);
    await loadOne();
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await loadOne();
      if (s === "done" || s === "error" || s === "no_recording") {
        clearInterval(poll.current!);
        onChange();
      }
    }, 2500);
  }

  if (!lecture) return null;
  const status = transcript?.status;
  const busy = ["pending", "downloading", "transcribing"].includes(status ?? "");
  const noRecording = status === "no_recording";
  const segments: TranscriptSegment[] = transcript?.segments ? JSON.parse(transcript.segments) : [];
  const isSlides = lecture.provider === "slides";
  const done = status === "done" && !!transcript?.text;
  const paragraphs = (transcript?.text ?? "").split(/\n{2,}/).filter((p) => p.trim());
  const hasNotes = !!transcript?.summary;
  const effectiveTab = tab === "timestamps" && segments.length === 0 ? "transcript" : tab;

  const tabs = [
    { key: "notes" as const, label: "Study notes" },
    { key: "transcript" as const, label: "Transcript" },
    ...(segments.length ? [{ key: "timestamps" as const, label: "Timestamps" }] : []),
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
          {(isSlides || noRecording) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
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

      {done && (
        <>
          <div className="mb-4">
            <Tabs tabs={tabs} value={effectiveTab} onChange={setTab} />
          </div>

          {effectiveTab === "notes" &&
            (hasNotes ? (
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

          {effectiveTab === "timestamps" && (
            <div className="pane max-h-[64vh] rounded-card bg-chip/50 p-4 text-sm leading-relaxed text-ink-soft">
              {segments.map((s, i) => (
                <p key={i} className="flex gap-3 rounded-field px-2 py-1 transition duration-150 hover:bg-surface">
                  <span className="shrink-0 select-none pt-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
                    {fmt(s.start)}
                  </span>
                  <span>{s.text}</span>
                </p>
              ))}
            </div>
          )}
        </>
      )}

      {noRecording && (
        <p className="text-sm text-ink-muted">
          This class hasn't been recorded/published yet. It'll transcribe automatically once the recording appears.
        </p>
      )}
      {!busy && !done && !noRecording && (
        <p className="text-sm text-ink-muted">
          Not processed yet — click {isSlides ? "Extract text" : "Transcribe"}.
        </p>
      )}
    </Card>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
